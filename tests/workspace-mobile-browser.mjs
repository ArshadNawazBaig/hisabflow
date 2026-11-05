// Run the complete save/upload/post/export workflow through touch-sized UI.
process.env.HISABFLOW_TEST_MOBILE='1';
await import('./workspace-browser.mjs');
