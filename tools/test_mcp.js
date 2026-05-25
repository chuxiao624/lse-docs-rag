import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(__dirname, '..', 'src', 'mcp_server.js')],
});

const client = new Client({ name: 'test-client', version: '0.0.0' });
await client.connect(transport);

console.log('=== Connected. Listing tools ===');
const tools = await client.listTools();
for (const t of tools.tools) {
  console.log(`\n  ${t.name}`);
  console.log(`    ${t.description.slice(0, 120)}...`);
}

console.log('\n\n=== Call: list_namespaces ===');
let res = await client.callTool({ name: 'list_namespaces', arguments: {} });
console.log(res.content[0].text);

console.log('\n\n=== Call: search_api { query: "怎么传送玩家", limit: 3 } ===');
res = await client.callTool({
  name: 'search_api',
  arguments: { query: '怎么传送玩家', limit: 3 },
});
console.log(res.content[0].text);

console.log('\n\n=== Call: search_api { query: "NBT 转 JSON", limit: 2 } ===');
res = await client.callTool({
  name: 'search_api',
  arguments: { query: 'NBT 转 JSON', limit: 2 },
});
console.log(res.content[0].text);

console.log('\n\n=== Call: search_api { query: "玩家进服", namespace: "EventAPI", limit: 2 } ===');
res = await client.callTool({
  name: 'search_api',
  arguments: { query: '玩家进服', namespace: 'EventAPI', limit: 2 },
});
console.log(res.content[0].text);

console.log('\n\n=== Call: get_api { id: "GameAPI.Player.teleport" } ===');
res = await client.callTool({
  name: 'get_api',
  arguments: { id: 'GameAPI.Player.teleport' },
});
console.log(res.content[0].text.slice(0, 800));
console.log('... (truncated)');

console.log('\n\n=== Call: list_members { namespace: "GameAPI", class: "BinaryStream" } ===');
res = await client.callTool({
  name: 'list_members',
  arguments: { namespace: 'GameAPI', class: 'BinaryStream' },
});
console.log(res.content[0].text);

console.log('\n\n=== Call: get_api { id: "nonexistent.id" } (error path) ===');
res = await client.callTool({
  name: 'get_api',
  arguments: { id: 'nonexistent.id' },
});
console.log(res.content[0].text);

await client.close();
console.log('\n\n=== Done ===');
