#!/usr/bin/env node

/**
 * AI Image API MCP Server test script
 */

import { AiImageApiClient } from './client.js';
import { listImages } from './storage.js';

async function testApiConnection() {
  console.log('🔧 AI Image API MCP Server - Connection Test\n');

  const client = new AiImageApiClient();

  // 1. Connection test
  console.log('1. Testing connection...');
  try {
    const isConnected = await client.testConnection();
    if (isConnected) {
      console.log('✅ Connection successful!\n');
    } else {
      console.log('❌ Connection failed\n');
      return;
    }
  } catch (error) {
    console.error('❌ Connection error:', error);
    return;
  }

  // 2. Model listing test
  console.log('2. Testing model listing...');
  try {
    const models = await client.getModels();
    const modelCount = Object.keys(models.models).length;
    console.log(`✅ Found ${modelCount} models:`);
    Object.entries(models.models).forEach(([name, config]) => {
      console.log(`   - ${name}: ${config.repo} - ${config.description}`);
    });
    console.log('');
  } catch (error) {
    console.error('❌ Model listing failed:', error);
  }

  // 3. Prompt optimization test
  console.log('3. Testing prompt optimization...');
  try {
    const optimization = await client.optimizeParameters({
      query: 'a cat in a garden'
    });
    console.log('✅ Prompt optimization successful:');
    console.log(`   Optimized: ${optimization.prompt}`);
    console.log(`   Negative: ${optimization.negative_prompt}`);
    console.log(`   Model: ${optimization.suggested_model}\n`);
  } catch (error) {
    console.error('❌ Prompt optimization failed:', error);
    console.log('ℹ️  This is expected if Job Manager is not running\n');
  }

  // 4. Stored image resource check
  console.log('4. Checking stored image resources...');
  try {
    const stored = await listImages();
    if (stored.length === 0) {
      console.log('ℹ️  No stored images yet. Run "npm run single-test" to generate one.\n');
    } else {
      const latest = stored[0];
      console.log(`✅ Found ${stored.length} stored images. Latest resource: ${latest.id}`);
      console.log(`   Prompt: ${latest.prompt}`);
      console.log(`   Created: ${latest.createdAt}`);
      console.log(`   Model: ${latest.model}\n`);
    }
  } catch (error) {
    console.error('❌ Failed to list stored images:', error);
  }

  // 5. Small image generation test (note: this actually hits the API)
  const shouldTestGeneration = process.argv.includes('--generate-test');
  if (shouldTestGeneration) {
    console.log('5. Testing image generation...');
    console.log('⚠️  This will actually generate an image using Modal.com resources');
    
    try {
      const result = await client.generateImage({
        prompt: 'a small test image, simple, minimalist',
        model: 'dreamshaper8',
        steps: 10,
        width: 512,
        height: 512,
        guidance_scale: 7.5,
        include_base64: true,
        include_metadata: true,
      });
      
      console.log('✅ Image generation successful!');
      const resolvedBase64 = result.image_base64
        ?? (await client.getImageByToken(result.image_token)).image_base64;

      if (resolvedBase64) {
        console.log(`   Image size: ${resolvedBase64.length} chars (base64)`);
      } else {
        console.log('   ⚠️ Image binary not returned; consult download URL or token APIs.');
      }

      if (result.download_url) {
        console.log(`   Download URL: ${result.download_url}`);
      }

      console.log(`   Image token: ${result.image_token}`);
      console.log('   Parameters used:', JSON.stringify(result.used_params ?? {}, null, 2));
    } catch (error) {
      console.error('❌ Image generation failed:', error);
    }
  } else {
    console.log('5. Skipping image generation test (use --generate-test to enable)');
  }

  console.log('\n🎉 Test completed!');
  console.log('\nUsage:');
  console.log('  npm run test              - Connection and listing tests only');
  console.log('  npm run test --generate   - Include actual image generation test');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testApiConnection().catch(console.error);
}