#!/usr/bin/env node

/**
 * Image generation demo using the MCP server
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';

async function generateImageViaMCP() {
  console.log('🎨 AI Image API MCP Server - Image Generation Demo\n');

  // Start the MCP server
  const mcpServer = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: process.cwd()
  });

  let messageId = 1;

  // Helper to send an MCP request
  const sendMCPRequest = (method: string, params: any = {}) => {
    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: '2.0',
        id: messageId++,
        method,
        params
      };

      let responseData = '';
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
  }, 60000); // 60-second timeout

      const onData = (data: Buffer) => {
        responseData += data.toString();
        try {
          const response = JSON.parse(responseData);
          clearTimeout(timeout);
          mcpServer.stdout?.off('data', onData);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        } catch (e) {
          // Keep accumulating until we have complete JSON
        }
      };

      mcpServer.stdout?.on('data', onData);
      mcpServer.stdin?.write(JSON.stringify(request) + '\n');
    });
  };

  try {
  // 1. Retrieve available models
  console.log('1. Fetching available models...');
    const modelsResult = await sendMCPRequest('tools/call', {
      name: 'get_available_models',
      arguments: {}
    }) as any;
    
    console.log('✅ Retrieved model catalog');

    // 2. Optimize a prompt
    console.log('\n2. Optimizing prompt...');
    const optimizeResult = await sendMCPRequest('tools/call', {
      name: 'optimize_prompt',
      arguments: {
        query: 'a cute cat beneath cherry blossoms in a beautiful garden',
        target_model: 'dreamshaper8'
      }
    }) as any;
    
    console.log('✅ Prompt optimized');

    // 3. Generate an image
    console.log('\n3. Generating image...');
    console.log('⚠️  This step may take a few minutes');
    
    const generateResult = await sendMCPRequest('tools/call', {
      name: 'generate_image',
      arguments: {
        prompt: 'a cute cat beneath cherry blossoms in a beautiful garden, high quality, detailed',
        model: 'dreamshaper8',
        negative_prompt: 'blurry, low quality, bad anatomy',
        width: 768,
        height: 512,
        steps: 20,
        guidance_scale: 7.5
      }
    }) as any;

    console.log('✅ Image generation completed!');

    // 4. Save the image
    if (generateResult.content && generateResult.content[0] && generateResult.content[0].type === 'image') {
      const imageBase64 = generateResult.content[0].data;
      const imageBuffer = Buffer.from(imageBase64, 'base64');
      
      const filename = `generated_image_${Date.now()}.png`;
      await fs.writeFile(filename, imageBuffer);
      
      console.log(`\n📁 Saved image: ${filename}`);
      
      // Display image metadata
      if (generateResult.content[1] && generateResult.content[1].type === 'text') {
        console.log('\n📋 Generation parameters:');
        console.log(generateResult.content[1].text);
      }
    }

  } catch (error) {
    console.error('❌ An error occurred:', error);
  } finally {
    mcpServer.kill();
  }
}

// Run the demo
if (import.meta.url === `file://${process.argv[1]}`) {
  generateImageViaMCP().catch(console.error);
}