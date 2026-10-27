/* Runs the live Cloudinary tests (real network, real account from .env).
   Needs the Firestore + Auth emulators (npm run emulators).
   Uploads only under the throw-away folder "oss-test" and deletes it all afterwards. */

import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/integration/cloudinary-live.test.js"], {
  stdio: "inherit",
  env: { ...process.env, CLOUDINARY_LIVE_TESTS: "1" }
});
process.exit(result.status ?? 1);
