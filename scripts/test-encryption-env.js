// Test-only key. Production startup remains fail-closed without an externally
// provisioned key; this module is loaded only by the npm test command.
process.env.AGENTIC_DATA_KEY ??= '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
