/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Config } from '@backstage/config';
import express from 'express';
import Router from 'express-promise-router';
import {
  createProxyMiddleware,
  fixRequestBody,
  Options,
  RequestHandler,
} from 'http-proxy-middleware';
import { Logger } from 'winston';
import http from 'http';
import { PluginEndpointDiscovery } from '@backstage/backend-common';

// A list of headers that are always forwarded to the proxy targets.
const safeForwardHeaders = [
  // https://fetch.spec.whatwg.org/#cors-safelisted-request-header
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma',

  // host is overridden by default. if changeOrigin is configured to false,
  // we assume this is a intentional and should also be forwarded.
  'host',

  // other headers that we assume to be ok
  'accept',
  'accept-language',
  'user-agent',
];

/** @public */
export interface RouterOptions {
  logger: Logger;
  config: Config;
  discovery: PluginEndpointDiscovery;
  skipInvalidProxies?: boolean;
  reviveConsumedRequestBodies?: boolean;
}

export interface ProxyConfig extends Options {
  allowedMethods?: string[];
  allowedHeaders?: string[];
  reviveRequestBody?: boolean;
}

// Creates a proxy middleware, possibly with defaults added on top of the
// given config.
export function buildMiddleware(
  pathPrefix: string,
  logger: Logger,
  route: string,
  config: string | ProxyConfig,
  reviveConsumedRequestBodies?: boolean,
): RequestHandler {
  const fullConfig =
    typeof config === 'string' ? { target: config } : { ...config };

  // Validate that target is a valid URL.
  if (typeof fullConfig.target !== 'string') {
    throw new Error(`Proxy target must be a string`);
  }
  try {
    // eslint-disable-next-line no-new
    new URL(fullConfig.target! as string);
  } catch {
    throw new Error(
      `Proxy target is not a valid URL: ${fullConfig.target ?? ''}`,
    );
  }

  // Default is to do a path rewrite that strips out the proxy's path prefix
  // and the rest of the route.
  if (fullConfig.pathRewrite === undefined) {
    let routeWithSlash = route.endsWith('/') ? route : `${route}/`;

    if (!pathPrefix.endsWith('/') && !routeWithSlash.startsWith('/')) {
      // Need to insert a / between pathPrefix and routeWithSlash
      routeWithSlash = `/${routeWithSlash}`;
    } else if (pathPrefix.endsWith('/') && routeWithSlash.startsWith('/')) {
      // Never expect this to happen at this point in time as
      // pathPrefix is set using `getExternalBaseUrl` which "Returns the
      // external HTTP base backend URL for a given plugin,
      // **without a trailing slash.**". But in case this changes in future, we
      // need to drop a / on either pathPrefix or routeWithSlash
      routeWithSlash = routeWithSlash.substring(1);
    }

    // The ? makes the slash optional for the rewrite, so that a base path without an ending slash
    // will also be matched (e.g. '/sample' and then requesting just '/api/proxy/sample' without an
    // ending slash). Otherwise the target gets called with the full '/api/proxy/sample' path
    // appended.
    fullConfig.pathRewrite = {
      [`^${pathPrefix}${routeWithSlash}?`]: '/',
    };
  }

  // Default is to update the Host header to the target
  if (fullConfig.changeOrigin === undefined) {
    fullConfig.changeOrigin = true;
  }

  // Attach the logger to the proxy config
  fullConfig.logProvider = () => logger;
  // http-proxy-middleware uses this log level to check if it should log the
  // requests that it proxies. Setting this to the most verbose log level
  // ensures that it always logs these requests. Our logger ends up deciding
  // if the logs are displayed or not.
  fullConfig.logLevel = 'debug';

  // Only return the allowed HTTP headers to not forward unwanted secret headers
  const requestHeaderAllowList = new Set<string>(
    [
      // allow all safe headers
      ...safeForwardHeaders,

      // allow all headers that are set by the proxy
      ...((fullConfig.headers && Object.keys(fullConfig.headers)) || []),

      // allow all configured headers
      ...(fullConfig.allowedHeaders || []),
    ].map(h => h.toLocaleLowerCase()),
  );

  // Use the custom middleware filter to do two things:
  //  1. Remove any headers not in the allow list to stop them being forwarded
  //  2. Only permit the allowed HTTP methods if configured
  //
  // We are filtering the proxy request headers here rather than in
  // `onProxyReq` because when global-agent is enabled then `onProxyReq`
  // fires _after_ the agent has already sent the headers to the proxy
  // target, causing a ERR_HTTP_HEADERS_SENT crash
  const filter = (_pathname: string, req: http.IncomingMessage): boolean => {
    const headerNames = Object.keys(req.headers);
    headerNames.forEach(h => {
      if (!requestHeaderAllowList.has(h.toLocaleLowerCase())) {
        delete req.headers[h];
      }
    });

    return fullConfig?.allowedMethods?.includes(req.method!) ?? true;
  };
  // Makes http-proxy-middleware logs look nicer and include the mount path
  filter.toString = () => route;

  // Only forward the allowed HTTP headers to not forward unwanted secret headers
  const responseHeaderAllowList = new Set<string>(
    [
      // allow all safe headers
      ...safeForwardHeaders,

      // allow all configured headers
      ...(fullConfig.allowedHeaders || []),
    ].map(h => h.toLocaleLowerCase()),
  );

  // only forward the allowed headers in backend->client
  fullConfig.onProxyRes = (proxyRes: http.IncomingMessage) => {
    const headerNames = Object.keys(proxyRes.headers);

    headerNames.forEach(h => {
      if (!responseHeaderAllowList.has(h.toLocaleLowerCase())) {
        delete proxyRes.headers[h];
      }
    });
  };

  if (reviveConsumedRequestBodies) {
    fullConfig.onProxyReq = fixRequestBody;
  }

  return createProxyMiddleware(filter, fullConfig);
}

function readProxyConfig(config: Config, logger: Logger): unknown {
  const endpoints = config.getOptional('proxy.endpoints');
  if (endpoints) {
    if (typeof endpoints !== 'object' || Array.isArray(endpoints)) {
      throw new Error('proxy configuration must be an object');
    }
    return endpoints;
  }

  const root = config.getOptional('proxy');
  if (!root) {
    return {};
  }
  if (typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('deprecated proxy configuration must be an object');
  }

  const rootEndpoints = Object.fromEntries(
    Object.entries(root).filter(([key]) => key.startsWith('/')),
  );
  if (Object.keys(rootEndpoints).length === 0) {
    return {};
  }

  logger.warn(
    "Configuring proxy endpoints in the root 'proxy' configuration is deprecated. Move this configuration to 'proxy.endpoints' instead.",
  );

  return rootEndpoints;
}

/**
 * Creates a new {@link https://expressjs.com/en/api.html#router | "express router"} that proxy each target configured under the `proxy` key of the config
 * @example
 * ```ts
 * let router = await createRouter({logger, config, discovery});
 * ```
 * @config
 * ```yaml
 * proxy:
 *  simple-example: http://simple.example.com:8080 # Opt 1 Simple URL String
 *  '/larger-example/v1': # Opt 2 `http-proxy-middleware` compatible object
 *    target: http://larger.example.com:8080/svc.v1
 *    headers:
 *      Authorization: Bearer ${EXAMPLE_AUTH_TOKEN}
 *```
 * @see https://backstage.io/docs/plugins/proxying
 * @public
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const router = Router();
  let currentRouter = Router();

  const skipInvalidProxies =
    options.skipInvalidProxies ??
    options.config.getOptionalBoolean('proxy.skipInvalidProxies') ??
    false;
  const reviveConsumedRequestBodies =
    options.reviveConsumedRequestBodies ??
    options.config.getOptionalBoolean('proxy.reviveConsumedRequestBodies') ??
    false;
  const proxyOptions = {
    skipInvalidProxies,
    reviveConsumedRequestBodies,
    logger: options.logger,
  };

  const externalUrl = await options.discovery.getExternalBaseUrl('proxy');
  const { pathname: pathPrefix } = new URL(externalUrl);

  const proxyConfig = readProxyConfig(options.config, options.logger);
  configureMiddlewares(proxyOptions, currentRouter, pathPrefix, proxyConfig);
  router.use((...args) => currentRouter(...args));

  if (options.config.subscribe) {
    let currentKey = JSON.stringify(proxyConfig);

    options.config.subscribe(() => {
      const newProxyConfig = readProxyConfig(options.config, options.logger);
      const newKey = JSON.stringify(newProxyConfig);

      if (currentKey !== newKey) {
        currentKey = newKey;
        currentRouter = Router();
        configureMiddlewares(
          proxyOptions,
          currentRouter,
          pathPrefix,
          newProxyConfig,
        );
      }
    });
  }

  return router;
}

function configureMiddlewares(
  options: {
    reviveConsumedRequestBodies: boolean;
    skipInvalidProxies: boolean;
    logger: Logger;
  },
  router: express.Router,
  pathPrefix: string,
  proxyConfig: any,
) {
  Object.entries<any>(proxyConfig).forEach(([route, proxyRouteConfig]) => {
    try {
      router.use(
        route,
        buildMiddleware(
          pathPrefix,
          options.logger,
          route,
          proxyRouteConfig,
          options.reviveConsumedRequestBodies,
        ),
      );
    } catch (e) {
      if (options.skipInvalidProxies) {
        options.logger.warn(`skipped configuring ${route} due to ${e.message}`);
      } else {
        throw e;
      }
    }
  });
}
