import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as Cdkvibecodingfes from '../lib/cdkvibecodingfes-stack';

describe('CdkvibecodingfesStack', () => {
  let app: cdk.App;
  let stack: Cdkvibecodingfes.CdkvibecodingfesStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new Cdkvibecodingfes.CdkvibecodingfesStack(app, 'MyTestStack');
    template = Template.fromStack(stack);
  });

  test('S3 Buckets are created', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: {
        'Fn::Join': [
          '',
          [
            'audio-files-bucket-',
            { Ref: 'AWS::AccountId' }
          ]
        ]
      }
    });

    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: {
        'Fn::Join': [
          '',
          [
            'processed-files-bucket-',
            { Ref: 'AWS::AccountId' }
          ]
        ]
      }
    });

    template.resourceCountIs('AWS::S3::Bucket', 2);
  });

  test('Lambda Functions are created', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'transcribe-processor.handler',
      Runtime: 'nodejs22.x',
      Timeout: 30,
      MemorySize: 256
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'minutes-generator.handler',
      Runtime: 'nodejs22.x',
      Timeout: 300,
      MemorySize: 512
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'email-sender.handler',
      Runtime: 'nodejs22.x',
      Timeout: 30,
      MemorySize: 256
    });

    // Note: CDK creates additional helper Lambda functions for custom resources
  });

  test('IAM Roles are created with correct policies', () => {
    // Verify Lambda service roles are created
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: {
            Service: 'lambda.amazonaws.com'
          }
        }]
      }
    });

    // Check that transcribe permissions exist in any role policy
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: [
        {
          PolicyDocument: {
            Statement: [
              {
                Action: 's3:GetObject',
                Effect: 'Allow'
              },
              {
                Action: 'transcribe:StartTranscriptionJob',
                Effect: 'Allow'
              }
            ]
          }
        }
      ]
    });

    // Check bedrock permissions
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: [
        {
          PolicyDocument: {
            Statement: [
              {
                Action: 'transcribe:GetTranscriptionJob',
                Effect: 'Allow'
              },
              {
                Action: 'bedrock:InvokeModel',
                Effect: 'Allow'
              },
              {
                Action: 's3:PutObject',
                Effect: 'Allow'
              },
              {
                Action: 'lambda:InvokeFunction',
                Effect: 'Allow'
              }
            ]
          }
        }
      ]
    });
  });

  test('S3 Event Notifications are configured', () => {
    // S3 notifications are created as custom resources in CDK
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          {
            Events: ['s3:ObjectCreated:*'],
            Filter: {
              Key: {
                FilterRules: [{
                  Name: 'suffix',
                  Value: '.mp3'
                }]
              }
            }
          },
          {
            Events: ['s3:ObjectCreated:*'],
            Filter: {
              Key: {
                FilterRules: [{
                  Name: 'suffix',
                  Value: '.wav'
                }]
              }
            }
          },
          {
            Events: ['s3:ObjectCreated:*'],
            Filter: {
              Key: {
                FilterRules: [{
                  Name: 'suffix',
                  Value: '.m4a'
                }]
              }
            }
          }
        ]
      }
    });
  });

  test('EventBridge Rule is created for Transcribe completion', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.transcribe'],
        'detail-type': ['Transcribe Job State Change'],
        detail: {
          TranscriptionJobStatus: ['COMPLETED']
        }
      }
    });

    template.resourceCountIs('AWS::Events::Rule', 1);
  });

  test('Stack outputs are created', () => {
    template.hasOutput('AudioFilesBucketName', {
      Description: 'Name of the S3 bucket for audio files'
    });

    template.hasOutput('ProcessedFilesBucketName', {
      Description: 'Name of the S3 bucket for processed files'
    });
  });

  test('CORS configuration is set on audio files bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [{
          AllowedOrigins: ['*'],
          AllowedMethods: ['PUT', 'POST'],
          AllowedHeaders: ['*']
        }]
      }
    });
  });

  test('Lambda permissions are set for S3 and EventBridge', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 's3.amazonaws.com'
    });

    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'events.amazonaws.com'
    });
  });
});