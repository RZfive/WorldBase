//! Canonical Electron public tool contracts.
//!
//! Native implementations serve non-Electron hosts, while Electron replaces
//! its domain tools with same-named host callbacks. This generated snapshot
//! keeps both paths' model-facing descriptions and JSON Schemas identical to
//! the established Electron agent surface. Regenerate it with
//! `pnpm --dir apps/electron generate:harness-tool-contracts`.

use crate::Tool;
use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

#[derive(Clone, Deserialize)]
pub struct ElectronToolContract {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Deserialize)]
struct ElectronToolContractDocument {
    version: u32,
    tools: Vec<ElectronToolContract>,
}

fn contracts() -> &'static HashMap<String, ElectronToolContract> {
    static CONTRACTS: OnceLock<HashMap<String, ElectronToolContract>> = OnceLock::new();
    CONTRACTS.get_or_init(|| {
        let document: ElectronToolContractDocument =
            serde_json::from_str(include_str!("../electron-tool-contracts.json"))
                .expect("generated Electron tool contracts must be valid JSON");
        assert_eq!(
            document.version, 1,
            "unsupported Electron tool contract version"
        );
        let source_count = document.tools.len();
        let contracts = document
            .tools
            .into_iter()
            .map(|contract| (contract.name.clone(), contract))
            .collect::<HashMap<_, _>>();
        assert_eq!(
            contracts.len(),
            source_count,
            "generated Electron tool contracts contain duplicate names"
        );
        contracts
    })
}

struct ElectronContractTool {
    inner: Arc<dyn Tool>,
    contract: ElectronToolContract,
}

#[async_trait]
impl Tool for ElectronContractTool {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn description(&self) -> &str {
        &self.contract.description
    }

    fn input_schema(&self) -> Value {
        self.contract.parameters.clone()
    }

    fn domain(&self) -> &str {
        self.inner.domain()
    }

    fn permission(&self) -> &str {
        self.inner.permission()
    }

    fn electron_native(&self) -> bool {
        self.inner.electron_native()
    }

    async fn execute(&self, input: Value, services: &crate::ToolServices) -> Result<Value> {
        self.inner.execute(input, services).await
    }
}

pub fn apply(tools: Vec<Arc<dyn Tool>>) -> Vec<Arc<dyn Tool>> {
    tools
        .into_iter()
        .map(|inner| match contracts().get(inner.name()).cloned() {
            Some(contract) => Arc::new(ElectronContractTool { inner, contract }) as Arc<dyn Tool>,
            None => inner,
        })
        .collect()
}

pub fn contains(name: &str) -> bool {
    contracts().contains_key(name)
}

pub fn names() -> Vec<String> {
    let mut names = contracts().keys().cloned().collect::<Vec<_>>();
    names.sort();
    names
}

#[cfg(test)]
pub fn all() -> Vec<ElectronToolContract> {
    let mut values = contracts().values().cloned().collect::<Vec<_>>();
    values.sort_by(|left, right| left.name.cmp(&right.name));
    values
}
