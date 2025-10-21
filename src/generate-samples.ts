#!/usr/bin/env node

/**
 * Demonstration script that calls the API directly to generate images
 */

import { AiImageApiClient } from './client.js';
import { promises as fs } from 'fs';

async function generateSampleImages() {
  console.log('🎨 AI Image Generation Demo – powered by the Modal.com API\n');

  const client = new AiImageApiClient();

  try {
    // 1. List all available models
    console.log('1. Fetching available models...');
    const models = await client.getModels();
    const modelNames = Object.keys(models.models);
    console.log(`✅ ${modelNames.length} models available: ${modelNames.join(', ')}\n`);

    // 2. Generate multiple sample images
    const samplePrompts = [
      {
        prompt: 'a cute cat sitting in a beautiful Japanese garden with cherry blossoms, soft lighting, detailed',
        model: 'dreamshaper8',
        description: 'Cat in a Japanese garden (photorealistic)'
      },
      {
        prompt: '1girl, anime style, beautiful face, detailed eyes, upper body, masterpiece, best quality',
        model: 'anything5', 
        description: 'Anime-style heroine'
      },
      {
        prompt: 'cyberpunk city at night, neon lights, futuristic architecture, detailed, high quality',
        model: 'cyberrealistic',
        description: 'Cyberpunk cityscape'
      }
    ];

    for (let i = 0; i < samplePrompts.length; i++) {
      const sample = samplePrompts[i];
      console.log(`${i + 1}. Generating ${sample.description}...`);
      console.log(`   Model: ${sample.model}`);
      console.log(`   Prompt: ${sample.prompt}`);
      
      try {
        const result = await client.generateImage({
          prompt: sample.prompt,
          model: sample.model,
          negative_prompt: 'blurry, low quality, bad anatomy, deformed',
          guidance_scale: 7.5,
          steps: 20,
          width: 512,
          height: 512,
          seed: Math.floor(Math.random() * 2147483647),
          include_base64: true,
          include_metadata: true,
        });

        // Save the generated image
        const filename = `sample_${i + 1}_${sample.model}_${Date.now()}.png`;
        const resolvedBase64 = result.image_base64
          ?? (await client.getImageByToken(result.image_token)).image_base64;

        if (!resolvedBase64) {
          throw new Error('Modal response did not include image_base64 payload.');
        }

        const imageBuffer = Buffer.from(resolvedBase64, 'base64');
        await fs.writeFile(filename, imageBuffer);
        
        console.log(`   ✅ Saved: ${filename}`);
        console.log(`   Parameters:`, JSON.stringify(result.used_params, null, 2));
        console.log('');
        
      } catch (error) {
        console.error(`   ❌ Generation failed: ${error}`);
        console.log('');
      }
    }

  } catch (error) {
    console.error('❌ An error occurred:', error);
  }
}

// Run the demo when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateSampleImages().catch(console.error);
}