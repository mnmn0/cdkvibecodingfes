import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as path from 'path';

export class CdkvibecodingfesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get email configuration from context
    const fromEmail = this.node.tryGetContext('fromEmail') || 'noreply@example.com';
    const toEmails = this.node.tryGetContext('toEmails') || 'recipient@example.com';

    // S3 Buckets
    const audioFilesBucket = new s3.Bucket(this, 'AudioFilesBucket', {
      bucketName: `audio-files-bucket-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [{
        allowedOrigins: ['*'],
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
        allowedHeaders: ['*'],
      }],
    });

    const processedFilesBucket = new s3.Bucket(this, 'ProcessedFilesBucket', {
      bucketName: `processed-files-bucket-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Lambda Functions
    
    // 1. TranscribeProcessor Lambda
    const transcribeProcessorRole = new iam.Role(this, 'TranscribeProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        TranscribePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject'],
              resources: [audioFilesBucket.arnForObjects('*')],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['transcribe:StartTranscriptionJob'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:PutObject'],
              resources: [processedFilesBucket.arnForObjects('*')],
            }),
          ],
        }),
      },
    });

    const transcribeProcessor = new lambda.Function(this, 'TranscribeProcessor', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'transcribe-processor.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      role: transcribeProcessorRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        PROCESSED_FILES_BUCKET: processedFilesBucket.bucketName,
      },
    });

    // 2. EmailSender Lambda
    const emailSenderRole = new iam.Role(this, 'EmailSenderRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        SESPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['ses:SendEmail', 'ses:SendRawEmail'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject'],
              resources: [processedFilesBucket.arnForObjects('*')],
            }),
          ],
        }),
      },
    });

    const emailSender = new lambda.Function(this, 'EmailSender', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'email-sender.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      role: emailSenderRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        FROM_EMAIL: fromEmail,
        TO_EMAILS: toEmails,
        PROCESSED_FILES_BUCKET: processedFilesBucket.bucketName,
      },
    });

    // 3. MinutesGenerator Lambda
    const minutesGeneratorRole = new iam.Role(this, 'MinutesGeneratorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        MinutesPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['transcribe:GetTranscriptionJob'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject'],
              resources: [processedFilesBucket.arnForObjects('*')],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['bedrock:InvokeModel'],
              resources: ['arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku*'],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:PutObject'],
              resources: [processedFilesBucket.arnForObjects('*')],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['lambda:InvokeFunction'],
              resources: [emailSender.functionArn],
            }),
          ],
        }),
      },
    });

    const minutesGenerator = new lambda.Function(this, 'MinutesGenerator', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'minutes-generator.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      role: minutesGeneratorRole,
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        PROCESSED_FILES_BUCKET: processedFilesBucket.bucketName,
        EMAIL_SENDER_FUNCTION_NAME: emailSender.functionName,
      },
    });

    // S3 Event Notification
    audioFilesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(transcribeProcessor),
      { suffix: '.mp3' }
    );
    audioFilesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(transcribeProcessor),
      { suffix: '.wav' }
    );
    audioFilesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(transcribeProcessor),
      { suffix: '.m4a' }
    );

    // EventBridge Rule for Transcribe Job State Change
    const transcribeRule = new events.Rule(this, 'TranscribeJobStateChangeRule', {
      eventPattern: {
        source: ['aws.transcribe'],
        detailType: ['Transcribe Job State Change'],
        detail: {
          TranscriptionJobStatus: ['COMPLETED'],
        },
      },
    });
    transcribeRule.addTarget(new targets.LambdaFunction(minutesGenerator));

    // Outputs
    new cdk.CfnOutput(this, 'AudioFilesBucketName', {
      value: audioFilesBucket.bucketName,
      description: 'Name of the S3 bucket for audio files',
    });

    new cdk.CfnOutput(this, 'ProcessedFilesBucketName', {
      value: processedFilesBucket.bucketName,
      description: 'Name of the S3 bucket for processed files',
    });
  }
}
