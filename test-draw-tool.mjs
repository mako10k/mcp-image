#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const testData = JSON.parse(readFileSync('./test-draw.json', 'utf8'));

const mcpServer = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

// Initialize MCP
const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
};

mcpServer.stdin.write(JSON.stringify(init) + '\n');

// Wait for init response
mcpServer.stdout.once('data', (data) => {
  console.log('Init response:', data.toString());
  
  // Send initialized notification
  mcpServer.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  }) + '\n');

  // Call draw_image tool
  const callTool = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'draw_image',
      arguments: testData
    }
  };

  mcpServer.stdin.write(JSON.stringify(callTool) + '\n');

  // Get tool response
  mcpServer.stdout.once('data', (data) => {
    console.log('Tool response:', data.toString());
    mcpServer.kill();
  });
});

setTimeout(() => {
  console.error('Timeout waiting for response');
  mcpServer.kill();
}, 5000);
