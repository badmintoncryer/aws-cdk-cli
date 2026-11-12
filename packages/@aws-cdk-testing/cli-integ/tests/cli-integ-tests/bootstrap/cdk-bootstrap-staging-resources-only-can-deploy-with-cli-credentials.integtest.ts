import { DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { integTest, withSpecificFixture } from '../../../lib';

integTest('bootstrap with --staging-resources-only and deploy with the CliCredentialsStackSynthesizer', withSpecificFixture('cli-credentials-app', async (fixture) => {
  const bootstrapStackName = fixture.bootstrapStackName;

  await fixture.cdkBootstrapModern({
    toolkitStackName: bootstrapStackName,
    stagingResourcesOnly: true,
  });

  const response = await fixture.aws.cloudFormation.send(
    new DescribeStackResourcesCommand({ StackName: bootstrapStackName }),
  );
  const resourceTypes = (response.StackResources ?? []).map(r => r.ResourceType);
  expect(resourceTypes).toEqual(expect.arrayContaining(['AWS::S3::Bucket', 'AWS::ECR::Repository', 'AWS::SSM::Parameter']));
  expect(resourceTypes.filter(t => t?.startsWith('AWS::IAM::'))).toEqual([]);

  // Publishes the file asset to the staging bucket and deploys with the CLI credentials
  await fixture.cdkDeploy('cli-credentials', {
    options: [
      '--toolkit-stack-name', bootstrapStackName,
      '--context', `@aws-cdk/core:bootstrapQualifier=${fixture.qualifier}`,
    ],
  });
}, { aws: { disableBootstrap: true } }));
