use crate::model::CodingPolicy;

/// Limits shared by the coding state machine and the core integration layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodingBudget {
    pub max_repair_rounds: u32,
    pub max_verification_commands: u32,
    pub command_timeout_ms: u64,
    pub max_output_bytes: usize,
}

impl From<&CodingPolicy> for CodingBudget {
    fn from(policy: &CodingPolicy) -> Self {
        Self {
            max_repair_rounds: policy.max_repair_rounds,
            max_verification_commands: policy.max_verification_commands,
            command_timeout_ms: policy.command_timeout_ms,
            max_output_bytes: policy.max_output_bytes,
        }
    }
}
