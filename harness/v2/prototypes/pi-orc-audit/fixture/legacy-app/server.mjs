import { createServer } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1) throw new Error("valid port required");
createServer((request, response) => {
  if (request.method === "POST" && request.url === "/request") {
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      response.writeHead(body.includes("weekday=Thursday") ? 201 : 409);
      response.end(body.includes("weekday=Thursday") ? "Standing slot confirmed" : "Slot refused");
    });
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>sauna fixture</title><h1>sauna</h1>'
    + '<form method="post" action="/request"><input name="household">'
    + '<select name="resource"></select><select name="weekday"></select>'
    + '<select name="start"></select></form>');
}).listen(port, "127.0.0.1");
