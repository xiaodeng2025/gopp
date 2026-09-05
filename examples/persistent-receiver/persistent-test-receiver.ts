import { createReferenceServer } from "../../receiver/reference/src/receiver.js";
import { SqliteTestStorage } from "../../receiver/reference/src/receiver-storage.js";

const token = process.env.GOPP_TOKEN;
const databasePath = process.env.GOPP_DB_PATH;
const host = process.env.GOPP_HOST ?? "127.0.0.1";
const portValue = Number.parseInt(process.env.GOPP_PORT ?? "8788", 10);

if (!token || !databasePath || host !== "127.0.0.1" ||
  !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
  process.stderr.write(
    "GOPP_TOKEN, GOPP_DB_PATH, GOPP_HOST=127.0.0.1, and a valid GOPP_PORT are required.\n",
  );
  process.exitCode = 1;
} else {
  const storage = new SqliteTestStorage(databasePath);
  const server = createReferenceServer({
    token,
    storage,
    site: {
      name: "GOPP Persistent Test Receiver",
      url: "http://127.0.0.1:" + portValue,
      locale: "en-US",
      timezone: "UTC",
    },
  });
  let closing = false;

  server.listen(portValue, host, () => {
    process.stdout.write("GOPP persistent test receiver is listening.\n");
  });

  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    server.close(() => {
      storage.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
