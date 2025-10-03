#!/usr/bin/env node

/**
 * MCP サーバを使用した画像生成デモ
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';

async function generateImageViaMCP() {
  console.log('🎨 AI Image API MCP Server - 画像生成デモ\n');

  // MCPサーバを起動
  const mcpServer = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: process.cwd()
  });

  let messageId = 1;

  // MCPリクエストを送信する関数
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
      }, 60000); // 60秒タイムアウト

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
          // JSONが完全でない場合は続行
        }
      };

      mcpServer.stdout?.on('data', onData);
      mcpServer.stdin?.write(JSON.stringify(request) + '\n');
    });
  };

  try {
    // 1. 利用可能なモデルを取得
    console.log('1. 利用可能なモデルを取得中...');
    const modelsResult = await sendMCPRequest('tools/call', {
      name: 'get_available_models',
      arguments: {}
    }) as any;
    
    console.log('✅ モデル一覧を取得しました');

    // 2. プロンプト最適化
    console.log('\n2. プロンプトを最適化中...');
    const optimizeResult = await sendMCPRequest('tools/call', {
      name: 'optimize_prompt',
      arguments: {
        query: '美しい日本庭園で桜の木の下にいる可愛い猫',
        target_model: 'dreamshaper8'
      }
    }) as any;
    
    console.log('✅ プロンプトを最適化しました');

    // 3. 画像生成
    console.log('\n3. 画像を生成中...');
    console.log('⚠️  この処理には数分かかる場合があります');
    
    const generateResult = await sendMCPRequest('tools/call', {
      name: 'generate_image',
      arguments: {
        prompt: '美しい日本庭園で桜の木の下にいる可愛い猫、高品質、詳細',
        quality_tier: 'standard',
        style_hint: 'realistic, beautiful lighting',
        size_preference: 'medium',
        experimental: false
      }
    }) as any;

    console.log('✅ 画像生成が完了しました！');

    // 4. 画像を保存
    if (generateResult.content && generateResult.content[0] && generateResult.content[0].type === 'image') {
      const imageBase64 = generateResult.content[0].data;
      const imageBuffer = Buffer.from(imageBase64, 'base64');
      
      const filename = `generated_image_${Date.now()}.png`;
      await fs.writeFile(filename, imageBuffer);
      
      console.log(`\n📁 画像を保存しました: ${filename}`);
      
      // 画像情報を表示
      if (generateResult.content[1] && generateResult.content[1].type === 'text') {
        console.log('\n📋 生成パラメータ:');
        console.log(generateResult.content[1].text);
      }
    }

  } catch (error) {
    console.error('❌ エラーが発生しました:', error);
  } finally {
    mcpServer.kill();
  }
}

// デモを実行
if (import.meta.url === `file://${process.argv[1]}`) {
  generateImageViaMCP().catch(console.error);
}