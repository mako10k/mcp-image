#!/usr/bin/env node

/**
 * Single-image generation smoke test via the MCP server
 */

import { AiImageApiClient } from './client.js';
import { promises as fs } from 'fs';

async function generateSingleImage() {
  console.log('🎨 MCP Server Single Image Test\n');

  const client = new AiImageApiClient();

  try {
  console.log('🌸 Generating a cherry blossom cat illustration...');
    
    const result = await client.generateImage({
      prompt: 'a fluffy orange cat sitting under blooming cherry blossom tree, beautiful pink petals falling, soft sunlight, peaceful Japanese garden, masterpiece, high quality, detailed',
      model: 'dreamshaper8',
      negative_prompt: 'blurry, low quality, bad anatomy, deformed, ugly, watermark',
      guidance_scale: 7.5,
      steps: 25,
      width: 512,
      height: 512,
      seed: 42, // Fixed seed for reproducibility
      include_base64: true,
      include_metadata: true,
    });

    // Save the generated image
    const filename = `mcp_demo_cherry_cat.png`;
    const resolvedBase64 = result.image_base64
      ?? (await client.getImageByToken(result.image_token)).image_base64;

    if (!resolvedBase64) {
      throw new Error('Modal response did not include image_base64 payload.');
    }

    const imageBuffer = Buffer.from(resolvedBase64, 'base64');
    await fs.writeFile(filename, imageBuffer);
    
    console.log(`✅ Saved image to: ${filename}`);
    console.log(`📏 Image size: ${imageBuffer.length} bytes`);
    console.log('\n📋 Parameters used:');
    console.log(JSON.stringify(result.used_params ?? {}, null, 2));
    console.log(`\n🔑 Image token: ${result.image_token}`);
    
    console.log('\n🎉 MCP server image generation test completed!');
    console.log('You can open this image from MCP clients such as VS Code or Claude.');

  } catch (error) {
    console.error('❌ Image generation failed:', error);
  }
}

// Run the test when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateSingleImage().catch(console.error);
}