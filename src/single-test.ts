#!/usr/bin/env node

/**
 * MCPサーバ経由での単一画像生成テスト
 */

import { AiImageApiClient } from './client.js';
import { promises as fs } from 'fs';

async function generateSingleImage() {
  console.log('🎨 MCPサーバ用 単一画像生成テスト\n');

  const client = new AiImageApiClient();

  try {
    console.log('🌸 美しい桜と猫の画像を生成中...');
    
    const result = await client.generateImage({
      prompt: 'a fluffy orange cat sitting under blooming cherry blossom tree, beautiful pink petals falling, soft sunlight, peaceful Japanese garden, masterpiece, high quality, detailed',
      model: 'dreamshaper8',
      negative_prompt: 'blurry, low quality, bad anatomy, deformed, ugly, watermark',
      guidance_scale: 7.5,
      steps: 25,
      width: 512,
      height: 512,
      seed: 42 // 固定シードで再現可能
    });

    // 画像を保存
    const filename = `mcp_demo_cherry_cat.png`;
    const imageBuffer = Buffer.from(result.image_base64, 'base64');
    await fs.writeFile(filename, imageBuffer);
    
    console.log(`✅ 画像を保存しました: ${filename}`);
    console.log(`📏 画像サイズ: ${imageBuffer.length} バイト`);
    console.log('\n📋 使用されたパラメータ:');
    console.log(JSON.stringify(result.used_params, null, 2));
    
    console.log('\n🎉 MCPサーバでの画像生成テストが完了しました！');
    console.log('この画像ファイルをVS CodeやClaude等で確認できます。');

  } catch (error) {
    console.error('❌ 画像生成に失敗しました:', error);
  }
}

// テストを実行
if (import.meta.url === `file://${process.argv[1]}`) {
  generateSingleImage().catch(console.error);
}