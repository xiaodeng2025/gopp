import { writeFileSync } from "node:fs";
import {
  formatConformanceReport,
  runConformance,
} from "./conformance.js";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function usage(): string {
  return [
    "Usage:",
    "  npm run conformance -- --url <receiver-base-url> --token <bearer-token> [--report <path>]",
    "",
    "The token is used for requests and is never printed or written to the report.",
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
} else {
  const baseUrl = optionValue(args, "--url");
  const token = optionValue(args, "--token") ?? process.env.GOPP_TOKEN;
  const reportPath = optionValue(args, "--report");

  if (!baseUrl || !token) {
    console.error(usage());
    process.exitCode = 2;
  } else {
    try {
      const report = await runConformance({ baseUrl, token });
      console.log(formatConformanceReport(report));
      if (reportPath) {
        writeFileSync(
          reportPath,
          JSON.stringify(report, null, 2) + "\n",
          "utf8",
        );
        console.log("JSON report written.");
      }
      process.exitCode = report.result === "pass" ? 0 : 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Conformance failed.";
      console.error(message.replaceAll(token, "[REDACTED]"));
      process.exitCode = 1;
    }
  }
}
