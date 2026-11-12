import { Bootstrapper } from '../../../lib/api/bootstrap';
import type { IIoHost } from '../../../lib/api/io';
import { asIoHelper } from '../../../lib/api/io/private';

let ioHost: IIoHost;
let ioHelper: any;
let template: any;

beforeEach(async () => {
  ioHost = {
    notify: jest.fn(),
    requestResponse: jest.fn(),
  };
  ioHelper = asIoHelper(ioHost, 'bootstrap');

  // GIVEN
  const bootstrapper = new Bootstrapper({ source: 'default' }, ioHelper);
  // WHEN
  template = await (bootstrapper as any).loadTemplate();
});

describe('bootstrap template', () => {
  test('denies AssumeRole with ExternalId by default', async () => {
    // THEN
    // Verify the parameter exists
    expect(template.Parameters.DenyExternalId).toMatchObject({
      Type: 'String',
      Default: 'true',
      AllowedValues: ['true', 'false'],
    });

    // Verify the condition exists
    expect(template.Conditions.ShouldDenyExternalId).toEqual({
      'Fn::Equals': ['true', { Ref: 'DenyExternalId' }],
    });

    // Verify each role has the ExternalId condition
    const rolesToCheck = [
      'FilePublishingRole',
      'ImagePublishingRole',
      'LookupRole',
      'DeploymentActionRole',
    ];

    for (const roleName of rolesToCheck) {
      const role = template.Resources[roleName];
      expect(role).toBeDefined();

      // Find AssumeRole statements for AWS principals (not service principals)
      const assumeRoleStatements = role.Properties.AssumeRolePolicyDocument.Statement.filter(
        (stmt: any) => stmt.Action === 'sts:AssumeRole' && stmt.Principal?.AWS,
      );

      // Each AssumeRole statement should have the ExternalId condition
      for (const stmt of assumeRoleStatements) {
        expect(stmt.Condition).toEqual({
          'Fn::If': [
            'ShouldDenyExternalId',
            { Null: { 'sts:ExternalId': 'true' } },
            { Ref: 'AWS::NoValue' },
          ],
        });
      }
    }

    // Verify CloudFormationExecutionRole does NOT have the condition (it's assumed by service)
    const cfnRole = template.Resources.CloudFormationExecutionRole;
    const cfnStatements = cfnRole.Properties.AssumeRolePolicyDocument.Statement;
    for (const stmt of cfnStatements) {
      expect(stmt.Condition).toBeUndefined();
    }
  });

  test('has the same values for BootstrapVersion Parameter and Output', async () => {
    expect(template.Outputs.BootstrapVersion.Value).toEqual(template.Resources.CdkBootstrapVersion.Properties.Value);
  });

  describe('StagingResourcesOnly', () => {
    test('is a parameter that defaults to false', () => {
      expect(template.Parameters.StagingResourcesOnly).toMatchObject({
        Type: 'String',
        Default: 'false',
        AllowedValues: ['true', 'false'],
      });
    });

    test('creates all resources by default', () => {
      const created = createdResources(template, {});
      expect(created).toEqual(Object.keys(template.Resources).filter(r => r !== 'CdkBoostrapPermissionsBoundaryPolicy'));
    });

    test('creates only the staging resources when set to true', () => {
      const created = createdResources(template, { StagingResourcesOnly: 'true' });
      expect(created).toEqual([
        'FileAssetsBucketEncryptionKey',
        'FileAssetsBucketEncryptionKeyAlias',
        'StagingBucket',
        'StagingBucketPolicy',
        'ContainerAssetsRepository',
        'CdkBootstrapVersion',
      ]);
    });

    test('does not create the example permissions boundary when set to true', () => {
      expect(createdResources(template, { UseExamplePermissionsBoundary: 'true' })).toContain('CdkBoostrapPermissionsBoundaryPolicy');
      expect(createdResources(template, { UseExamplePermissionsBoundary: 'true', StagingResourcesOnly: 'true' }))
        .not.toContain('CdkBoostrapPermissionsBoundaryPolicy');
    });

    test.each([
      ['default', {}],
      ['staging resources only', { StagingResourcesOnly: 'true' }],
      ['staging resources only with an existing KMS key', { StagingResourcesOnly: 'true', FileAssetsBucketKmsKeyId: 'my-key' }],
      ['staging resources only with the AWS managed key', { StagingResourcesOnly: 'true', FileAssetsBucketKmsKeyId: 'AWS_MANAGED_KEY' }],
    ])('%s: resources and outputs only reference resources that are created', (_, parameters: Record<string, string>) => {
      const created = new Set(createdResources(template, parameters));
      const referenced = new Set<string>();
      for (const name of created) {
        collectReferences(template.Resources[name], template, parameters, referenced);
      }
      for (const output of Object.values(template.Outputs)) {
        collectReferences(output, template, parameters, referenced);
      }

      const dangling = [...referenced].filter(r => !created.has(r) && !(r in template.Parameters) && !r.startsWith('AWS::'));
      expect(dangling).toEqual([]);
    });
  });
});

/**
 * Evaluate a template condition the way CloudFormation would, for the given parameters
 * (falling back to parameter defaults)
 */
function evaluateCondition(expression: any, tmpl: any, parameters: Record<string, string>): any {
  if (typeof expression !== 'object' || expression === null) {
    return expression;
  }
  const evaluate = (inner: any) => evaluateCondition(inner, tmpl, parameters);
  const [intrinsic, args] = Object.entries(expression)[0] as [string, any];
  switch (intrinsic) {
    case 'Ref': return parameters[args] ?? tmpl.Parameters[args].Default;
    case 'Condition': return evaluate(tmpl.Conditions[args]);
    case 'Fn::Equals': return evaluate(args[0]) === evaluate(args[1]);
    case 'Fn::Not': return !evaluate(args[0]);
    case 'Fn::And': return args.every(evaluate);
    case 'Fn::Or': return args.some(evaluate);
    // A list parameter is represented by its comma-separated string value
    case 'Fn::Join': return Array.isArray(args[1]) ? args[1].map(evaluate).join(args[0]) : evaluate(args[1]);
    default: throw new Error(`Unsupported intrinsic in condition: ${intrinsic}`);
  }
}

function isConditionTrue(name: string, tmpl: any, parameters: Record<string, string>): boolean {
  return Boolean(evaluateCondition({ Condition: name }, tmpl, parameters));
}

function createdResources(tmpl: any, parameters: Record<string, string>): string[] {
  return Object.entries(tmpl.Resources)
    .filter(([_, resource]: [string, any]) => resource.Condition === undefined || isConditionTrue(resource.Condition, tmpl, parameters))
    .map(([name]) => name);
}

/**
 * Collect the logical IDs referenced by a template fragment, only following the `Fn::If` branches that are taken
 */
function collectReferences(fragment: any, tmpl: any, parameters: Record<string, string>, into: Set<string>) {
  if (Array.isArray(fragment)) {
    fragment.forEach(x => collectReferences(x, tmpl, parameters, into));
    return;
  }
  if (typeof fragment !== 'object' || fragment === null) {
    return;
  }
  for (const [key, value] of Object.entries(fragment) as Array<[string, any]>) {
    if (key === 'Fn::If') {
      collectReferences(isConditionTrue(value[0], tmpl, parameters) ? value[1] : value[2], tmpl, parameters, into);
    } else if (key === 'Ref') {
      into.add(value);
    } else if (key === 'Fn::GetAtt') {
      into.add(Array.isArray(value) ? value[0] : value.split('.')[0]);
    } else if (key === 'Fn::Sub') {
      const str: string = Array.isArray(value) ? value[0] : value;
      for (const match of str.matchAll(/\$\{([^}!]+)\}/g)) {
        into.add(match[1].split('.')[0]);
      }
    } else {
      collectReferences(value, tmpl, parameters, into);
    }
  }
}
