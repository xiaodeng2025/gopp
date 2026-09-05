import { GoppClient } from "../../publisher/typescript/src/client.js";

const url = process.env.GOPP_RECEIVER_URL;
const token = process.env.GOPP_RECEIVER_TOKEN;
if (!url || !token) throw new Error("GOPP_RECEIVER_URL and GOPP_RECEIVER_TOKEN are required.");

const client = new GoppClient({ baseUrl: url, token });
const verified = await client.verify();
console.log(`GOPP ${verified.protocol_version} verified`);
if (verified.capabilities.channels) console.log(`channels=${(await client.getChannels()).length}`);
const content = { title: "GOPP Basic Publisher Example", content: { format: "html" as const, body: "<p>Synthetic GOPP content.</p>" } };
console.log((await client.putContent("example-basic-1", content)).result);
console.log((await client.putContent("example-basic-1", content)).result);
