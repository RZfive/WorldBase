//! Deterministic write-batch planning for multi-file edits.
//!
//! The planner is pure and never reads the filesystem. It groups independent
//! writes, serializes writes to the same file, and orders dependent writes
//! after the files they depend on. Dependency cycles are conservatively
//! serialized in deterministic path/index order instead of deadlocking.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedWrite {
    pub file_path: PathBuf,
    /// Files this write depends on (for example imported modules).
    pub depends_on: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteBatch {
    pub edits: Vec<PlannedWrite>,
}

struct Node {
    edit: PlannedWrite,
    key: PathBuf,
    outgoing: Vec<usize>,
}

/// Plan writes into deterministic batches.
///
/// A batch contains at most one write per file. Independent writes are sorted
/// by normalized path. Same-file writes keep their original relative order and
/// appear in consecutive batches. If a dependency cycle is found, one
/// deterministic member is serialized at a time until the cycle is drained.
pub fn plan_write_batches(edits: Vec<PlannedWrite>) -> Vec<WriteBatch> {
    if edits.is_empty() {
        return Vec::new();
    }

    let mut nodes = edits
        .into_iter()
        .map(|edit| Node {
            key: normalize_key(&edit.file_path),
            edit,
            outgoing: Vec::new(),
        })
        .collect::<Vec<_>>();

    let mut file_groups: HashMap<PathBuf, Vec<usize>> = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        file_groups.entry(node.key.clone()).or_default().push(index);
    }

    let mut edges = HashSet::new();
    for group in file_groups.values() {
        for pair in group.windows(2) {
            edges.insert((pair[0], pair[1]));
        }
    }

    for (index, node) in nodes.iter().enumerate() {
        for dependency in &node.edit.depends_on {
            let dependency_key = normalize_key(dependency);
            if dependency_key == node.key {
                continue;
            }
            let Some(group) = file_groups.get(&dependency_key) else {
                continue;
            };
            for &dependency_index in group {
                edges.insert((dependency_index, index));
            }
        }
    }

    for (from, to) in edges {
        nodes[from].outgoing.push(to);
    }

    let mut indegree = vec![0usize; nodes.len()];
    for node in &nodes {
        for &target in &node.outgoing {
            indegree[target] += 1;
        }
    }

    let mut remaining = (0..nodes.len()).collect::<BTreeSet<_>>();
    let mut batches = Vec::new();

    while !remaining.is_empty() {
        let mut ready = remaining
            .iter()
            .copied()
            .filter(|index| indegree[*index] == 0)
            .collect::<Vec<_>>();

        if ready.is_empty() {
            let chosen = remaining
                .iter()
                .copied()
                .min_by(|left, right| {
                    node_sort_key(&nodes[*left], *left).cmp(&node_sort_key(&nodes[*right], *right))
                })
                .expect("non-empty remaining set");
            ready.push(chosen);
        }

        ready.sort_by(|left, right| {
            node_sort_key(&nodes[*left], *left).cmp(&node_sort_key(&nodes[*right], *right))
        });

        for &index in &ready {
            remaining.remove(&index);
        }
        for &index in &ready {
            for &target in &nodes[index].outgoing {
                if remaining.contains(&target) {
                    indegree[target] = indegree[target].saturating_sub(1);
                }
            }
        }

        batches.push(WriteBatch {
            edits: ready
                .into_iter()
                .map(|index| nodes[index].edit.clone())
                .collect(),
        });
    }

    batches
}

fn node_sort_key(node: &Node, index: usize) -> (&PathBuf, usize) {
    (&node.key, index)
}

fn normalize_key(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}
