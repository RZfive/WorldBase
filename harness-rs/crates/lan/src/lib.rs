//! LAN peer discovery for WorldBase.
//!
//! Discovery is intentionally self-contained: a small UDP multicast protocol
//! advertises the local WorldBase instance and collects other instances on the
//! same LAN. HTTP collaboration APIs stay in the host  -  this crate only owns
//! the network identity/probe layer so every harness client observes the same
//! peer snapshot.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 76, 87);
pub const DISCOVERY_PORT: u16 = 19528;
pub const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(3);
pub const PEER_TTL: Duration = Duration::from_secs(12);
pub const MAX_PACKET_BYTES: usize = 16 * 1024;

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// Public identity advertised on the LAN. It must not contain secrets: the
/// packet is visible to every host on the local network.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryIdentity {
    pub instance_id: String,
    pub display_name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub groups: Vec<DiscoveryGroupSummary>,
}

impl DiscoveryIdentity {
    fn normalized(mut self) -> Self {
        self.instance_id = self.instance_id.trim().to_string();
        if self.instance_id.is_empty() {
            self.instance_id = format!("worldbase-{}", uuid::Uuid::new_v4().simple());
        }
        self.display_name = self.display_name.trim().to_string();
        if self.display_name.is_empty() {
            self.display_name = self.hostname.trim().to_string();
        }
        if self.display_name.is_empty() {
            self.display_name = "WorldBase".to_string();
        }
        self.role = self.role.trim().to_string();
        self.avatar = self.avatar.trim().to_string();
        self.background = self.background.trim().to_string();
        self.tags = self
            .tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .take(6)
            .collect();
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        self.groups.sort_by(|left, right| left.id.cmp(&right.id));
        self.groups.dedup_by(|left, right| left.id == right.id);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryGroupSummary {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub member_count: u32,
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub join_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPeer {
    pub instance_id: String,
    pub display_name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub groups: Vec<DiscoveryGroupSummary>,
    /// Source address of the UDP packet, useful for diagnostics when the
    /// advertised URL contains an unreachable interface.
    pub address: String,
    pub last_seen_at: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryStatus {
    pub running: bool,
    pub enabled: bool,
    pub local: Option<DiscoveryIdentity>,
    pub peers: Vec<DiscoveredPeer>,
    pub multicast_address: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryPacket {
    version: u32,
    kind: String,
    sent_at_ms: u64,
    identity: DiscoveryIdentity,
}

impl DiscoveryPacket {
    fn new(kind: &str, identity: DiscoveryIdentity) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            kind: kind.to_string(),
            sent_at_ms: now_ms(),
            identity,
        }
    }

    fn encode(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).context("encode discovery packet")
    }

    fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_PACKET_BYTES {
            anyhow::bail!("discovery packet is too large");
        }
        let packet: Self = serde_json::from_slice(bytes).context("decode discovery packet")?;
        if packet.version != PROTOCOL_VERSION {
            anyhow::bail!("unsupported discovery protocol version {}", packet.version);
        }
        if packet.kind != "announce" && packet.kind != "probe" {
            anyhow::bail!("unsupported discovery packet kind");
        }
        Ok(packet)
    }
}

#[derive(Debug, Clone)]
struct PeerEntry {
    peer: DiscoveredPeer,
    seen_at: Instant,
}

#[derive(Default)]
struct DiscoveryState {
    running: bool,
    enabled: bool,
    identity: Option<DiscoveryIdentity>,
    peers: HashMap<String, PeerEntry>,
    error: Option<String>,
}

/// Thread-safe discovery service owned by one harness process.
pub struct DiscoveryService {
    state: Mutex<DiscoveryState>,
    generation: AtomicU64,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Default for DiscoveryService {
    fn default() -> Self {
        Self::new()
    }
}

impl DiscoveryService {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(DiscoveryState::default()),
            generation: AtomicU64::new(0),
            thread: Mutex::new(None),
        }
    }

    pub fn start(self: &Arc<Self>, identity: DiscoveryIdentity) -> Result<DiscoveryStatus> {
        let identity = identity.normalized();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.stop_thread();
        {
            let mut state = self.state.lock().unwrap();
            state.running = false;
            state.error = None;
        }
        let socket = bind_discovery_socket()?;
        socket
            .join_multicast_v4(&MULTICAST_ADDR, &Ipv4Addr::UNSPECIFIED)
            .context("join WorldBase multicast group")?;
        socket
            .set_read_timeout(Some(Duration::from_millis(400)))
            .context("configure discovery read timeout")?;
        {
            let mut state = self.state.lock().unwrap();
            state.running = true;
            state.enabled = true;
            state.identity = Some(identity.clone());
            state.peers.clear();
            state.error = None;
        }
        let _ = send_packet(&socket, &DiscoveryPacket::new("probe", identity.clone()));
        let _ = send_packet(&socket, &DiscoveryPacket::new("announce", identity));

        let service = self.clone();
        let thread = match std::thread::Builder::new()
            .name("worldbase-lan-discovery".into())
            .spawn(move || {
                let mut buffer = vec![0u8; MAX_PACKET_BYTES];
                loop {
                    if service.generation.load(Ordering::SeqCst) != generation {
                        break;
                    }
                    let identity = {
                        let state = service.state.lock().unwrap();
                        if !state.running || !state.enabled {
                            None
                        } else {
                            state.identity.clone()
                        }
                    };
                    let Some(identity) = identity else {
                        break;
                    };

                    let _ =
                        send_packet(&socket, &DiscoveryPacket::new("announce", identity.clone()));
                    let deadline = Instant::now() + ANNOUNCE_INTERVAL;
                    while Instant::now() < deadline {
                        if service.generation.load(Ordering::SeqCst) != generation {
                            break;
                        }
                        match socket.recv_from(&mut buffer) {
                            Ok((size, address)) => {
                                let Ok(packet) = DiscoveryPacket::decode(&buffer[..size]) else {
                                    continue;
                                };
                                let should_answer_probe = packet.kind == "probe";
                                {
                                    let mut state = service.state.lock().unwrap();
                                    record_packet(&mut state, packet, address, Instant::now());
                                    if let Some(error) = state.error.take() {
                                        tracing::debug!(%error, "LAN discovery recovered");
                                    }
                                }
                                if should_answer_probe {
                                    let _ = send_packet(
                                        &socket,
                                        &DiscoveryPacket::new("announce", identity.clone()),
                                    );
                                }
                            }
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    std::io::ErrorKind::WouldBlock
                                        | std::io::ErrorKind::TimedOut
                                        | std::io::ErrorKind::Interrupted
                                ) => {}
                            Err(error) => {
                                tracing::warn!(%error, "LAN discovery receive failed");
                                if let Ok(mut state) = service.state.lock() {
                                    state.error = Some(error.to_string());
                                }
                                std::thread::sleep(Duration::from_millis(200));
                            }
                        }
                    }
                }
            }) {
            Ok(thread) => thread,
            Err(error) => {
                let mut state = self.state.lock().unwrap();
                state.running = false;
                state.error = Some(error.to_string());
                return Err(error).context("spawn LAN discovery thread");
            }
        };
        *self.thread.lock().unwrap() = Some(thread);
        Ok(self.status())
    }

    /// Replace the advertised identity without dropping known peers.
    pub fn update(&self, identity: DiscoveryIdentity) -> Result<DiscoveryStatus> {
        let identity = identity.normalized();
        {
            let mut state = self.state.lock().unwrap();
            state.identity = Some(identity);
            state.enabled = true;
            state.error = None;
        }
        Ok(self.status())
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        {
            let mut state = self.state.lock().unwrap();
            state.running = false;
            state.enabled = false;
            state.error = None;
        }
        self.stop_thread();
    }

    /// Return the current snapshot. The discovery loop already announces every
    /// few seconds, so a UI refresh does not need to block on network I/O.
    pub fn refresh(&self) -> DiscoveryStatus {
        self.status()
    }

    pub fn status(&self) -> DiscoveryStatus {
        let mut state = self.state.lock().unwrap();
        expire_peers(&mut state.peers);
        let mut peers = state
            .peers
            .values()
            .map(|entry| entry.peer.clone())
            .collect::<Vec<_>>();
        peers.sort_by(|left, right| {
            right
                .last_seen_at
                .cmp(&left.last_seen_at)
                .then_with(|| left.display_name.cmp(&right.display_name))
        });
        DiscoveryStatus {
            running: state.running,
            enabled: state.enabled,
            local: state.identity.clone(),
            peers,
            multicast_address: MULTICAST_ADDR.to_string(),
            port: DISCOVERY_PORT,
            error: state.error.clone(),
        }
    }

    fn stop_thread(&self) {
        if let Some(handle) = self.thread.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}

fn bind_discovery_socket() -> Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .context("create LAN discovery socket")?;
    socket
        .set_reuse_address(true)
        .context("enable discovery address reuse")?;
    #[cfg(unix)]
    socket
        .set_reuse_port(true)
        .context("enable discovery port reuse")?;
    socket
        .set_nonblocking(false)
        .context("configure discovery socket mode")?;
    socket
        .set_multicast_loop_v4(true)
        .context("enable discovery multicast loopback")?;
    socket
        .bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT).into())
        .context("bind LAN discovery port")?;
    Ok(socket.into())
}

fn send_packet(socket: &UdpSocket, packet: &DiscoveryPacket) -> Result<()> {
    let bytes = packet.encode()?;
    if bytes.len() > MAX_PACKET_BYTES {
        anyhow::bail!("discovery packet exceeds LAN budget");
    }
    socket
        .send_to(&bytes, SocketAddrV4::new(MULTICAST_ADDR, DISCOVERY_PORT))
        .context("send LAN discovery packet")?;
    Ok(())
}

fn record_packet(
    state: &mut DiscoveryState,
    packet: DiscoveryPacket,
    address: SocketAddr,
    now: Instant,
) {
    let lan_source = match address.ip() {
        std::net::IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_loopback()
                || octets[0] == 10
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 169 && octets[1] == 254)
        }
        std::net::IpAddr::V6(_) => false,
    };
    if !lan_source {
        return;
    }
    let Some(local) = state.identity.as_ref() else {
        return;
    };
    let identity = packet.identity.normalized();
    if identity.instance_id == local.instance_id {
        return;
    }
    let last_seen_at =
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(packet.sent_at_ms as i64)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let peer = DiscoveredPeer {
        instance_id: identity.instance_id.clone(),
        display_name: identity.display_name.clone(),
        role: identity.role.clone(),
        avatar: identity.avatar.clone(),
        background: identity.background.clone(),
        tags: identity.tags.clone(),
        base_url: identity.base_url.clone(),
        app_version: identity.app_version.clone(),
        hostname: identity.hostname.clone(),
        capabilities: identity.capabilities.clone(),
        groups: identity.groups.clone(),
        address: address.ip().to_string(),
        last_seen_at,
        online: true,
    };
    state
        .peers
        .insert(identity.instance_id, PeerEntry { peer, seen_at: now });
}

fn expire_peers(peers: &mut HashMap<String, PeerEntry>) {
    let now = Instant::now();
    peers.retain(|_, entry| now.duration_since(entry.seen_at) <= PEER_TTL);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(name: &str) -> DiscoveryIdentity {
        DiscoveryIdentity {
            instance_id: format!("id-{name}"),
            display_name: name.into(),
            role: "研发".into(),
            avatar: "🧑‍💻".into(),
            background: "aurora".into(),
            tags: vec!["AI".into()],
            base_url: "http://192.168.1.10:19527".into(),
            app_version: "1.7.6".into(),
            hostname: "studio-mac".into(),
            capabilities: vec!["online-group/v1".into()],
            groups: vec![],
        }
    }

    #[test]
    fn packet_round_trip_requires_supported_version() {
        let packet = DiscoveryPacket::new("announce", identity("A"));
        let bytes = packet.encode().unwrap();
        let decoded = DiscoveryPacket::decode(&bytes).unwrap();
        assert_eq!(decoded.identity.display_name, "A");

        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["version"] = serde_json::json!(99);
        let bad = serde_json::to_vec(&value).unwrap();
        assert!(DiscoveryPacket::decode(&bad).is_err());
    }

    #[test]
    fn peer_snapshot_ignores_self_and_expires_stale_entries() {
        let service = DiscoveryService::new();
        let mut state = service.state.lock().unwrap();
        state.identity = Some(identity("local"));

        record_packet(
            &mut state,
            DiscoveryPacket::new("announce", identity("remote")),
            "192.168.1.20:19528".parse().unwrap(),
            Instant::now(),
        );
        record_packet(
            &mut state,
            DiscoveryPacket::new("announce", identity("local")),
            "192.168.1.10:19528".parse().unwrap(),
            Instant::now(),
        );
        assert_eq!(state.peers.len(), 1);

        state.peers.get_mut("id-remote").unwrap().seen_at =
            Instant::now() - PEER_TTL - Duration::from_secs(1);
        expire_peers(&mut state.peers);
        assert!(state.peers.is_empty());
    }

    #[test]
    fn identity_normalization_is_stable() {
        let mut value = identity("  ");
        value.instance_id = "  ".into();
        value.base_url = " http://192.168.1.10:19527/ ".into();
        let normalized = value.normalized();
        assert!(!normalized.instance_id.is_empty());
        assert_eq!(normalized.display_name, "studio-mac");
        assert_eq!(normalized.base_url, "http://192.168.1.10:19527");
    }

    #[test]
    fn two_services_discover_each_other_over_multicast() {
        let first = Arc::new(DiscoveryService::new());
        let second = Arc::new(DiscoveryService::new());
        let mut first_identity = identity("first");
        first_identity.base_url = "http://127.0.0.1:19527".into();
        let mut second_identity = identity("second");
        second_identity.base_url = "http://127.0.0.1:19528".into();

        first.start(first_identity).expect("start first discovery");
        second
            .start(second_identity)
            .expect("start second discovery");
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let first_peers = first.status().peers;
            let second_peers = second.status().peers;
            if first_peers
                .iter()
                .any(|peer| peer.instance_id == "id-second")
                && second_peers
                    .iter()
                    .any(|peer| peer.instance_id == "id-first")
            {
                break;
            }
            if Instant::now() >= deadline {
                first.stop();
                second.stop();
                panic!(
                    "multicast discovery did not converge: first={first_peers:?} second={second_peers:?}"
                );
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        first.stop();
        second.stop();
    }
}
