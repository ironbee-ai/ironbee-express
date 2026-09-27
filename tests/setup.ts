/**
 * Global jest setup (setupFilesAfterEnv). Keeps the suite hermetic: no test
 * may pick up a developer's engine / text-model keys from the environment.
 */

const HERMETIC_VARS: string[] = [
    "TYPESAFE_API_KEY",
    "JEV_API_KEY",
    "TYPESAFE_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "OPENROUTER_BASE_URL",
    "CLAUDE_CODE_CLI",
    "CODEX_CLI",
    "IBEXPRESS_ENGINE",
    "IBEXPRESS_TEXT_MODEL",
    "IBEXPRESS_TEXT_CANDIDATES",
];

for (const name of HERMETIC_VARS) {
    delete process.env[name];
}

// Nor a developer's IronBee login: the shared config file is read when no key is set.
process.env.IBEXPRESS_IRONBEE_CONFIG = "/nonexistent/ironbee-express-tests/config.json";

// Nor the examples that ship with the app, nor a developer's recording cache: a test's are its own.
process.env.IBEXPRESS_SCENARIO_DIR = "/nonexistent/ironbee-express-tests/scenarios";
process.env.IBEXPRESS_CACHE_DIR = "/nonexistent/ironbee-express-tests/cache";
