const path = require('path');
const cdk = require('aws-cdk-lib/core');
const lambda = require('aws-cdk-lib/aws-lambda');

const stackPrefix = process.env.STACK_NAME_PREFIX;
if (!stackPrefix) {
  throw new Error(`the STACK_NAME_PREFIX environment variable is required`);
}

/**
 * A stack with a file asset that is deployed with the credentials of the CLI,
 * so it does not need any of the bootstrap roles.
 */
class CliCredentialsStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, {
      ...props,
      // The qualifier is read from the `@aws-cdk/core:bootstrapQualifier` context
      synthesizer: new cdk.CliCredentialsStackSynthesizer(),
    });

    new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
    });
  }
}

const app = new cdk.App();
new CliCredentialsStack(app, `${stackPrefix}-cli-credentials`);

app.synth();
