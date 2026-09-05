"""TEST ONLY: generic backend-like input to a GOPP Receiver."""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "publisher" / "python"))
from gopp import GoppClient, credential_from_env


def main() -> None:
    url = os.environ["GOPP_RECEIVER_URL"]
    token = credential_from_env("GOPP_RECEIVER_TOKEN")
    source_id = os.environ.get("GOPP_SOURCE_ID", "example-isolated-1")
    channel_id = os.environ.get("GOPP_CHANNEL_ID")
    article = json.loads(Path(os.environ.get("GOPP_ARTICLE_PATH", "synthetic-article.json")).read_text(encoding="utf-8"))
    content = {"title": article["title"], "content": {"format": "html", "body": article["content_html"]}, "status": article.get("status", "draft")}
    if channel_id:
        content["channel"] = {"id": channel_id}
    allow_loopback = os.environ.get("GOPP_ALLOW_LOOPBACK_TEST") == "1"
    client = GoppClient(url, token, allow_loopback=allow_loopback)
    client.verify()
    results = [client.put_content(source_id, content)["result"], client.put_content(source_id, content)["result"]]
    updated = {**content, "title": content["title"] + " Updated"}
    results += [client.put_content(source_id, updated)["result"], client.put_content(source_id, updated)["result"]]
    print("execution_level=API_LEVEL")
    print(" → ".join(results))
    if results != ["created", "unchanged", "updated", "unchanged"]:
        raise SystemExit("unexpected GOPP lifecycle")


if __name__ == "__main__":
    main()
