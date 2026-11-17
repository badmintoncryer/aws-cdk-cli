import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { integTest, withSpecificFixture } from '../../../lib';

integTest('switch an existing bootstrap stack to --staging-resources-only and back', withSpecificFixture('cli-credentials-app', async (fixture) => {
  const bootstrapStackName = fixture.bootstrapStackName;
  const bootstrap = (...args: string[]) => fixture.cdk([
    'bootstrap',
    '--toolkit-stack-name', bootstrapStackName,
    '--qualifier', fixture.qualifier,
    // A customer managed key has a key policy that refers to the file publishing role
    '--bootstrap-customer-key',
    ...args,
  ], { modEnv: { CDK_NEW_BOOTSTRAP: '1' } });

  await bootstrap('--cloudformation-execution-policies', 'arn:aws:iam::aws:policy/AdministratorAccess');
  expect(await iamResourceTypes(fixture.aws.cloudFormation, bootstrapStackName)).not.toEqual([]);

  // Deleting the roles of an existing stack requires --force
  await expect(bootstrap('--staging-resources-only')).rejects.toThrow();
  expect(await iamResourceTypes(fixture.aws.cloudFormation, bootstrapStackName)).not.toEqual([]);

  await bootstrap('--staging-resources-only', '--force');
  expect(await iamResourceTypes(fixture.aws.cloudFormation, bootstrapStackName)).toEqual([]);

  // The CLI credentials can still publish to the bucket encrypted with the customer managed key
  await fixture.cdkDeploy('cli-credentials', {
    options: [
      '--toolkit-stack-name', bootstrapStackName,
      '--context', `@aws-cdk/core:bootstrapQualifier=${fixture.qualifier}`,
    ],
  });

  await bootstrap('--no-staging-resources-only');
  expect(await iamResourceTypes(fixture.aws.cloudFormation, bootstrapStackName)).toEqual(expect.arrayContaining([
    'AWS::IAM::Role',
    'AWS::IAM::Policy',
  ]));
}, { aws: { disableBootstrap: true } }));

async function iamResourceTypes(cloudFormation: CloudFormationClient, stackName: string): Promise<string[]> {
  const response = await cloudFormation.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  return (response.StackResources ?? [])
    .map(r => r.ResourceType ?? '')
    .filter(t => t.startsWith('AWS::IAM::'));
}
