/** Reconcile the client's projection key with the Host registration surface. */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

const client = fs.readFileSync(path.join(root, "client.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.js"), "utf8");

const clientKey = /useProjection\(\s*["']([^"']+)["']\s*\)/.exec(client);
console.log("client 读取的投影 key:", clientKey === null ? "(none)" : clientKey[1]);

console.log("index 里是否注册过 sessionProjections:", /sessionProjections/.test(index));
console.log("index 里是否调用过 register:", /\.register\(\s*\{/.test(index));

const typesPath = path.join(
  "D:/Program Files/DSH Desktop/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-session-projection/lib/types/index.js",
);
console.log("projection types 文件存在:", fs.existsSync(typesPath));
