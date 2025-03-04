import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { getFixturePath } from '../jest/util/getFixturePath';

const featureFlagDefaults = (): Map<string, boolean> => {
  return new Map([
    ['cliFailFast', false],
    ['iacIntegratedExperience', false],
    ['containerCliAppVulnsEnabled', true],
  ]);
};

export type FakeServer = {
  getRequests: () => express.Request[];
  popRequest: () => express.Request;
  popRequests: (num: number) => express.Request[];
  setDepGraphResponse: (next: Record<string, unknown>) => void;
  setNextResponse: (r: any) => void;
  setNextStatusCode: (c: number) => void;
  setStatusCode: (c: number) => void;
  setStatusCodes: (c: number[]) => void;
  setFeatureFlag: (featureFlag: string, enabled: boolean) => void;
  unauthorizeAction: (action: string, reason?: string) => void;
  listen: (port: string | number, callback: () => void) => void;
  listenPromise: (port: string | number) => Promise<void>;
  listenWithHttps: (
    port: string | number,
    options: https.ServerOptions,
  ) => Promise<void>;
  restore: () => void;
  close: (callback: () => void) => void;
  closePromise: () => Promise<void>;
  getPort: () => number;
};

export const fakeServer = (basePath: string, snykToken: string): FakeServer => {
  let requests: express.Request[] = [];
  let featureFlags: Map<string, boolean> = featureFlagDefaults();
  let unauthorizedActions = new Map();
  // the status code to return for the next request, overriding statusCode
  let nextStatusCode: number | undefined = undefined;
  // the status code to return for all the requests
  let statusCode: number | undefined = undefined;
  let statusCodes: number[] = [];
  let nextResponse: any = undefined;
  let depGraphResponse: Record<string, unknown> | undefined = undefined;
  let server: http.Server | undefined = undefined;

  const restore = () => {
    statusCode = undefined;
    requests = [];
    depGraphResponse = undefined;
    featureFlags = featureFlagDefaults();
    unauthorizedActions = new Map();
  };

  const getRequests = () => {
    return requests;
  };

  const popRequest = () => {
    return requests.pop()!;
  };

  const popRequests = (num: number) => {
    return requests.splice(requests.length - num, num);
  };

  const setDepGraphResponse = (next: typeof depGraphResponse) => {
    depGraphResponse = next;
  };

  const setNextResponse = (response: string | Record<string, unknown>) => {
    if (typeof response === 'string') {
      nextResponse = JSON.parse(response);
      return;
    }
    nextResponse = response;
  };

  const setNextStatusCode = (code: number) => {
    nextStatusCode = code;
  };

  const setStatusCode = (code: number) => {
    statusCode = code;
  };

  const setStatusCodes = (codes: number[]) => {
    statusCodes = codes;
  };

  const setFeatureFlag = (featureFlag: string, enabled: boolean) => {
    featureFlags.set(featureFlag, enabled);
  };

  const unauthorizeAction = (
    action: string,
    reason = 'unauthorized by test',
  ) => {
    unauthorizedActions.set(action, {
      allowed: false,
      reason,
    });
  };

  const app = express();
  app.use(bodyParser.json({ limit: '50mb' }));
  // Content-Type for rest API endpoints is 'application/vnd.api+json'
  app.use(express.json({ type: 'application/vnd.api+json', strict: false }));
  app.use((req, res, next) => {
    requests.push(req);
    next();
  });

  [basePath + '/verify/callback', basePath + '/verify/token'].map((url) => {
    app.post(url, (req, res) => {
      if (req.body.api === snykToken) {
        return res.send({
          ok: true,
          api: snykToken,
        });
      }

      if (req.body.token) {
        return res.send({
          ok: true,
          api: snykToken,
        });
      }

      res.status(401);
      res.send({
        ok: false,
      });
    });
  });

  app.use((req, res, next) => {
    if (
      req.url?.includes('/iac-org-settings') ||
      req.url?.includes('/cli-config/feature-flags/') ||
      (!nextResponse && !nextStatusCode && !statusCode)
    ) {
      return next();
    }
    const response = nextResponse;
    nextResponse = undefined;
    if (nextStatusCode) {
      const code = nextStatusCode;
      nextStatusCode = undefined;
      res.status(code);
    } else if (statusCode) {
      res.status(statusCode);
    }

    res.send(response);
  });

  app.get(basePath + '/vuln/:registry/:module', (req, res) => {
    try {
      // Use one of the fixtures if it exists.
      const body = fs.readFileSync(
        path.resolve(getFixturePath('cli-test-results'), req.params.module),
        'utf8',
      );
      res.send(JSON.parse(body));
    } catch {
      res.send({
        vulnerabilities: [],
      });
    }
  });

  app.post(basePath + '/vuln/:registry', (req, res, next) => {
    const vulnerabilities = [];
    if (req.query.org && req.query.org === 'missing-org') {
      res.status(404);
      res.send({
        code: 404,
        userMessage:
          'Org missing-org was not found or you may not have the correct permissions',
      });
      return next();
    }
    res.send({
      vulnerabilities,
      org: 'test-org',
      isPrivate: true,
    });
    return next();
  });

  app.post(basePath + '/vuln/:registry/patches', (req, res, next) => {
    res.send({
      vulnerabilities: [],
    });
    return next();
  });

  app.post(basePath + '/test-dep-graph', (req, res, next) => {
    if (req.query.org && req.query.org === 'missing-org') {
      res.status(404);
      res.send({
        code: 404,
        userMessage:
          'Org missing-org was not found or you may not have the correct permissions',
      });
      return next();
    }

    const statusCode = statusCodes.shift();
    if (statusCode && statusCode !== 200) {
      res.sendStatus(statusCode);
      return next();
    }

    if (depGraphResponse) {
      res.send(depGraphResponse);
      return next();
    }

    res.send({
      result: {
        issuesData: {},
        affectedPkgs: {},
      },
      meta: {
        org: 'test-org',
        isPublic: false,
      },
    });
    return next();
  });

  app.post(basePath + '/docker-jwt/test-dependencies', (req, res, next) => {
    if (
      req.headers.authorization &&
      !req.headers.authorization.includes('Bearer')
    ) {
      res.status(401).send();
      return;
    }

    res.send({
      result: {
        issues: [],
        issuesData: {},
        depGraphData: {
          schemaVersion: '1.2.0',
          pkgManager: {
            name: 'rpm',
            repositories: [{ alias: 'rhel:8.2' }],
          },
          pkgs: [
            {
              id: 'docker-image|foo@1.2.3',
              info: {
                name: 'docker-image|foo',
                version: '1.2.3',
              },
            },
          ],
          graph: {
            rootNodeId: 'root-node',
            nodes: [
              {
                nodeId: 'root-node',
                pkgId: 'docker-image|foo@1.2.3',
                deps: [],
              },
            ],
          },
        },
      },
      meta: {
        org: 'test-org',
        isPublic: false,
      },
    });
    return next();
  });

  app.post(basePath + '/test-dependencies', (req, res) => {
    if (req.query.org && req.query.org === 'missing-org') {
      res.status(404).send({
        code: 404,
        userMessage:
          'Org missing-org was not found or you may not have the correct permissions',
      });
      return;
    }

    res.send({
      result: {
        issues: [],
        issuesData: {},
        depGraphData: {
          schemaVersion: '1.2.0',
          pkgManager: {
            name: 'rpm',
            repositories: [{ alias: 'rhel:8.2' }],
          },
          pkgs: [
            {
              id: 'docker-image|foo@1.2.3',
              info: {
                name: 'docker-image|foo',
                version: '1.2.3',
              },
            },
          ],
          graph: {
            rootNodeId: 'root-node',
            nodes: [
              {
                nodeId: 'root-node',
                pkgId: 'docker-image|foo@1.2.3',
                deps: [],
              },
            ],
          },
        },
      },
      meta: {
        org: 'test-org',
        isPublic: false,
      },
    });
  });

  app.put(basePath + '/monitor-dependencies', (req, res) => {
    if (req.query.org && req.query.org === 'missing-org') {
      res.status(404).send({
        code: 404,
        userMessage:
          'Org missing-org was not found or you may not have the correct permissions',
      });
      return;
    }

    res.send({
      ok: true,
      org: 'test-org',
      id: 'project-public-id',
      isMonitored: true,
      trialStarted: true,
      licensesPolicy: {},
      uri:
        'http://example-url/project/project-public-id/history/snapshot-public-id',
      projectName: 'test-project',
    });
  });

  app.get(basePath + '/cli-config/feature-flags/:featureFlag', (req, res) => {
    const org = req.query.org;
    const flag = req.params.featureFlag;
    if (org === 'no-flag') {
      res.send({
        ok: false,
        userMessage: `Org ${org} doesn't have '${flag}' feature enabled'`,
      });
      return;
    }

    if (featureFlags.has(flag)) {
      const ffEnabled = featureFlags.get(flag);
      if (ffEnabled) {
        res.send({
          ok: true,
        });
      } else {
        res.send({
          ok: false,
          userMessage: `Org ${org} doesn't have '${flag}' feature enabled'`,
        });
      }
      return;
    }

    // default: return true for all feature flags
    res.send({
      ok: true,
    });
  });

  app.get(basePath + '/iac-org-settings', (req, res) => {
    const baseResponse = {
      meta: {
        isPrivate: false,
        isLicensesEnabled: false,
        ignoreSettings: null,
        org: req.query.org || 'test-org',
      },
      customPolicies: {},
      customRules: {},
      entitlements: {
        infrastructureAsCode: true,
        iacCustomRulesEntitlement: true,
        iacDrift: true,
      },
    };

    if (req.query.org === 'no-iac-entitlements') {
      return res.status(200).send({
        ...baseResponse,
        entitlements: {
          ...baseResponse.entitlements,
          infrastructureAsCode: false,
        },
      });
    }

    if (req.query.org === 'no-custom-rules-entitlements') {
      return res.status(200).send({
        ...baseResponse,
        entitlements: {
          ...baseResponse.entitlements,
          iacCustomRulesEntitlement: false,
        },
      });
    }

    if (req.query.org === 'no-iac-drift-entitlements') {
      return res.status(200).send({
        ...baseResponse,
        entitlements: {
          ...baseResponse.entitlements,
          iacDrift: false,
        },
      });
    }

    if (req.query.org === 'custom-policies') {
      return res.status(200).send({
        ...baseResponse,
        customPolicies: {
          'SNYK-CC-AZURE-543': { severity: 'none' },
        },
      });
    }

    res.status(200).send(baseResponse);
  });

  app.get(basePath + '/authorization/:action', (req, res) => {
    const result = unauthorizedActions.get(req.params.action) || {
      allowed: true,
      reason: 'Default fake server response.',
    };
    res.send({ result });
  });

  app.put(basePath + '/monitor/:registry/graph', (req, res, next) => {
    res.send({
      id: 'monitor',
      uri: `${req.params.registry}/graph/some/project-id`,
      isMonitored: true,
    });
    return next();
  });

  app.put(basePath + '/monitor/:registry', (req, res) => {
    res.send({
      id: 'monitor',
      uri: `${req.params.registry}/some/project-id`,
      isMonitored: true,
    });
  });

  // Apps endpoint
  app.post(`${basePath}/orgs/:orgId/apps`, (req, res) => {
    const { orgId } = req.params;
    const name = req.body.name;
    const redirect_uris = req.body.redirect_uris;
    const scopes = req.body.scopes;
    res.send(
      JSON.stringify({
        jsonapi: {
          version: '1.0',
        },
        data: {
          type: 'app',
          id: '84144c1d-a491-4fe5-94d1-ba143ba71b6d',
          attributes: {
            name,
            client_id: '9f26c6c6-e04b-4310-8ce4-c3a6289d0633',
            redirect_uris,
            scopes,
            is_public: false,
            client_secret: 'super-secret-client-secret',
            access_token_ttl_seconds: 3600,
          },
          links: {
            self: `/orgs/${orgId}/apps?version=2022-03-11~experimental`,
          },
        },
      }),
    );
  });

  app.post(basePath + '/track-iac-usage/cli', (req, res) => {
    res.status(200).send({});
  });

  app.post(basePath + '/iac-cli-share-results', (req, res) => {
    res.status(200).send({});
  });

  app.post(basePath + '/analytics/cli', (req, res) => {
    res.status(200).send({});
  });

  app.post(
    basePath.replace('v1', 'hidden') + '/orgs/:org/sbom',
    express.json(),
    (req, res) => {
      let bom: Record<string, unknown> = { bomFormat: 'CycloneDX' };

      if (Array.isArray(req.body.depGraphs) && req.body.subject) {
        // Return a fixture of an all-projects SBOM.
        bom = {
          ...bom,
          metadata: { component: { name: req.body.subject.name } },
        };
      }

      res.status(200).send(bom);
    },
  );

  app.get(basePath + '/download/driftctl', (req, res) => {
    const fixturePath = getFixturePath('iac');
    const path1 = path.join(fixturePath, 'drift', 'download-test.sh');
    const body = fs.readFileSync(path1);
    res.send(body);
  });

  // Post state mapping artifact
  app.post(
    basePath.replace('v1', 'hidden') +
      '/orgs/:orgId/cloud/mappings_artifact/tfstate',
    (req, res) => {
      const { orgId } = req.params;
      const artifact = path.join(
        getFixturePath('iac'),
        'capture',
        orgId + '-artifact.json',
      );
      fs.writeFileSync(artifact, JSON.stringify(req.body));
      res.status(201).send({});
    },
  );

  const listenPromise = (port: string | number) => {
    return new Promise<void>((resolve) => {
      server = http.createServer(app).listen(Number(port), resolve);
    });
  };

  const listen = (port: string | number, callback: () => void) => {
    listenPromise(port).then(callback);
  };

  const listenWithHttps = (
    port: string | number,
    options: https.ServerOptions,
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      server = https.createServer(options, app);
      server.once('listening', () => {
        resolve();
      });
      server.once('error', (err) => {
        reject(err);
      });
      server.listen(Number(port));
    });
  };

  const closePromise = () => {
    return new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server = undefined;
    });
  };

  const close = (callback: () => void) => {
    closePromise().then(callback);
  };

  const getPort = () => {
    const address = server?.address();
    if (address && typeof address === 'object') {
      return address.port;
    }
    throw new Error('port not found');
  };

  return {
    getRequests,
    popRequest,
    popRequests,
    setDepGraphResponse,
    setNextResponse,
    setNextStatusCode,
    setStatusCode,
    setStatusCodes,
    setFeatureFlag,
    unauthorizeAction,
    listen,
    listenPromise,
    listenWithHttps,
    restore,
    close,
    closePromise,
    getPort,
  };
};
