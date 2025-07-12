# 音声議事録自動生成システム アーキテクチャ設計書

## 概要

音声ファイルをS3にアップロードすると、自動的に文字起こし→議事録生成→メール送信を行うサーバーレスシステム

## システムアーキテクチャ

### アーキテクチャ図

```
[ユーザー] 
    ↓ 音声ファイルアップロード (.mp3, .wav, .m4a)
[S3 Bucket: audio-files-bucket]
    ↓ S3 Event Notification (ObjectCreated)
[Lambda: TranscribeProcessor]
    ↓ StartTranscriptionJob API
[Amazon Transcribe]
    ↓ Transcription完了 (CloudWatch Events)
[Lambda: MinutesGenerator]
    ↓ InvokeModel API (Claude-3)
[Amazon Bedrock]
    ↓ 生成された議事録
[Lambda: EmailSender]
    ↓ SendEmail API
[Amazon SES]
    ↓ 議事録メール送信
[関係者メールアドレス]

[ストレージ]
- S3 Bucket: processed-files-bucket (文字起こし結果、議事録保存)

[監視・ログ]
- CloudWatch Logs (各Lambda関数のログ)
- CloudWatch Metrics (処理時間、エラー率)
```

## コンポーネント詳細

### 1. S3 Buckets

#### audio-files-bucket
- **用途**: 音声ファイルのアップロード先
- **イベント**: ObjectCreated時にLambda実行
- **対応形式**: mp3, wav, m4a, flac

#### processed-files-bucket
- **用途**: 処理結果の保存
- **構造**:
  ```
  /transcriptions/{job-id}.json
  /minutes/{job-id}.md
  ```

### 2. Lambda Functions

#### TranscribeProcessor
- **トリガー**: S3 ObjectCreated Event
- **処理**:
  1. 音声ファイル情報取得
  2. Transcribe Job開始
  3. Job IDをCloudWatch Logsに記録
- **実行時間**: 30秒
- **メモリ**: 256MB

#### MinutesGenerator
- **トリガー**: Transcribe Job完了 (CloudWatch Events)
- **処理**:
  1. Transcription結果取得
  2. Bedrockで議事録生成
  3. S3に議事録保存
  4. EmailSender Lambdaを呼び出し
- **実行時間**: 300秒
- **メモリ**: 512MB

#### EmailSender
- **トリガー**: MinutesGenerator からの呼び出し
- **処理**:
  1. 議事録内容取得
  2. SESでメール送信
- **実行時間**: 30秒
- **メモリ**: 256MB

### 3. Amazon Transcribe

- **設定**:
  - Speaker Diarization: 有効 (話者分離)
  - Language: ja-JP
  - Audio Format: 自動検出

### 4. Amazon Bedrock

- **モデル**: Claude-3 Haiku (コスト効率重視)
- **プロンプト**:
  ```
  以下の文字起こし結果から、構造化された議事録を作成してください。

  要件:
  - 日時、参加者、議題、決定事項、アクションアイテムを含む
  - 話者別に整理
  - 重要なポイントを箇条書きで整理
  
  文字起こし結果:
  {transcription_text}
  ```

### 5. Amazon SES

- **送信者**: noreply@{domain}
- **件名**: "議事録が生成されました - {timestamp}"
- **本文**: 議事録内容 + S3ダウンロードリンク

## セキュリティ設計

### IAM Roles

#### TranscribeProcessorRole
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::audio-files-bucket/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "transcribe:StartTranscriptionJob"
      ],
      "Resource": "*"
    }
  ]
}
```

#### MinutesGeneratorRole
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "transcribe:GetTranscriptionJob"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel"
      ],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::processed-files-bucket/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "lambda:InvokeFunction"
      ],
      "Resource": "arn:aws:lambda:*:*:function:EmailSender"
    }
  ]
}
```

## 運用設計

### 監視・アラート

#### CloudWatch Metrics
- Lambda実行時間
- Lambda エラー率
- Transcribe Job成功率
- SES送信成功率

#### CloudWatch Alarms
- Lambda関数のエラー率 > 5%
- Transcribe Job失敗率 > 10%
- 処理時間が想定より長い場合

### ログ設計

#### 構造化ログ
```json
{
  "timestamp": "2024-01-01T10:00:00Z",
  "requestId": "abc-123",
  "jobId": "transcribe-job-456",
  "fileName": "meeting-20240101.mp3",
  "status": "success|error",
  "processingTime": 120,
  "error": "error message if any"
}
```

## コスト試算

### 月間1000ファイル処理の場合

| サービス | 使用量 | 料金 |
|---------|--------|------|
| S3 | 100GB保存 | $2.30 |
| Lambda | 1000実行×3関数 | $0.20 |
| Transcribe | 1000時間 | $144.00 |
| Bedrock | 1000リクエスト | $3.00 |
| SES | 1000通 | $0.10 |
| **合計** | | **$149.60** |

## 拡張性

### 将来的な機能追加
1. WebUI での処理状況確認
2. 複数言語対応
3. 音声品質の事前チェック
4. 議事録テンプレートのカスタマイズ
5. Slack/Teams連携

### スケーラビリティ
- 同時処理数: Transcribeの同時Job数制限 (デフォルト100)
- ファイルサイズ: 最大2GB (Transcribe制限)
- 処理時間: 音声1時間あたり約3-5分

## 開発・デプロイ

### 技術スタック
- **IaC**: AWS CDK (TypeScript)
- **Runtime**: Node.js 22.x
- **テスト**: Jest

### デプロイフロー
1. CDK Synthでテンプレート生成
2. CDK Deployでスタックデプロイ
3. Lambda関数の動作確認
