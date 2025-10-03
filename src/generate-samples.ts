#!/usr/bin/env node

/**
 * 直接API呼び出しによる画像生成デモ
 */

import { AiImageApiClient } from './client.js';
import { promises as fs } from 'fs';

async function generateSampleImages() {
  console.log('🎨 AI画像生成デモ - Modal.com API使用\n');

  const client = new AiImageApiClient();

  try {
    // 1. 利用可能なモデルを確認
    console.log('1. 利用可能なモデルを確認中...');
    const models = await client.getModels();
    const modelNames = Object.keys(models.models);
    console.log(`✅ ${modelNames.length}個のモデルが利用可能: ${modelNames.join(', ')}\n`);

    // 2. 複数のサンプル画像を生成
    const samplePrompts = [
      {
        prompt: 'a cute cat sitting in a beautiful Japanese garden with cherry blossoms, soft lighting, detailed',
        model: 'dreamshaper8',
        description: '日本庭園の猫（リアル系）'
      },
      {
        prompt: '1girl, anime style, beautiful face, detailed eyes, upper body, masterpiece, best quality',
        model: 'anything5', 
        description: 'アニメ風美少女'
      },
      {
        prompt: 'cyberpunk city at night, neon lights, futuristic architecture, detailed, high quality',
        model: 'cyberrealistic',
        description: 'サイバーパンク都市'
      }
    ];

    for (let i = 0; i < samplePrompts.length; i++) {
      const sample = samplePrompts[i];
      console.log(`${i + 1}. ${sample.description}を生成中...`);
      console.log(`   モデル: ${sample.model}`);
      console.log(`   プロンプト: ${sample.prompt}`);
      
      try {
        const result = await client.generateImage({
          prompt: sample.prompt,
          model: sample.model,
          negative_prompt: 'blurry, low quality, bad anatomy, deformed',
          guidance_scale: 7.5,
          steps: 20,
          width: 512,
          height: 512,
          seed: Math.floor(Math.random() * 2147483647)
        });

        // 画像を保存
        const filename = `sample_${i + 1}_${sample.model}_${Date.now()}.png`;
        const imageBuffer = Buffer.from(result.image_base64, 'base64');
        await fs.writeFile(filename, imageBuffer);
        
        console.log(`   ✅ 保存完了: ${filename}`);
        console.log(`   使用パラメータ:`, JSON.stringify(result.used_params, null, 2));
        console.log('');
        
      } catch (error) {
        console.error(`   ❌ 生成失敗: ${error}`);
        console.log('');
      }
    }

  } catch (error) {
    console.error('❌ エラーが発生しました:', error);
  }
}

// デモを実行
if (import.meta.url === `file://${process.argv[1]}`) {
  generateSampleImages().catch(console.error);
}