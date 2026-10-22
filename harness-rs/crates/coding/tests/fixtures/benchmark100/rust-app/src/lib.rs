use std::collections::HashMap;

pub struct User {
    pub name: String,
}

pub trait Greeter {
    fn greet(&self) -> String;
}

pub enum Mode {
    On,
    Off,
}

pub type UserId = u64;

pub const MAX_RETRIES: usize = 3;

static DEFAULT_TIMEOUT: u64 = 30;

impl User {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
        }
    }

    fn rename(&mut self, name: &str) {
        self.name = name.to_string();
    }

    pub fn greet(&self) -> String {
        format!("hello {}", self.name)
    }
}

pub fn health_check() -> bool {
    true
}

pub fn status() -> bool {
    health_check()
}

fn helper() {}
