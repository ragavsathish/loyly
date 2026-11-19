import { createServer } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1) throw new Error("valid port required");
createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>sauna fixture</title><h1>sauna</h1>");
}).listen(port, "127.0.0.1");
