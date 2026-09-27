import type { Config } from "jest";

// The live integration suite talks to a real DevTools daemon and a real site;
// it runs only when IBEXPRESS_E2E_DAEMON_URL points at a daemon.

const config: Config = {
    preset: "ts-jest",
    testEnvironment: "node",
    setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
    testMatch: ["**/tests/**/*.test.ts"],
    collectCoverageFrom: ["src/**/*.ts"],
    testPathIgnorePatterns: ["/node_modules/"],
};

export default config;
