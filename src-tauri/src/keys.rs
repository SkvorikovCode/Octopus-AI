//! Legacy provider API keys in the OS keychain (saved by early builds), still
//! passed to the agent as environment variables. New keys live with custom
//! providers, see `providers.rs`.

use keyring::Entry;

const SERVICE: &str = "ai.octopus.desktop";

/// (id, environment variable the agent reads)
const PROVIDERS: &[(&str, &str)] = &[
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
];

fn read(id: &str) -> Option<String> {
    Entry::new(SERVICE, id)
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.is_empty())
}

pub fn env_pairs() -> Vec<(&'static str, String)> {
    PROVIDERS
        .iter()
        .filter_map(|(id, env)| read(id).map(|key| (*env, key)))
        .collect()
}
