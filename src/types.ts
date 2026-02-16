export interface ApiParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
}

export interface RequestBodyProperty {
  type: string;
  description?: string;
  required?: boolean;
  items?: { type: string };
}

export interface RequestBodySchema {
  contentType: string;
  properties: Record<string, RequestBodyProperty>;
}

export interface ApiResponse {
  statusCode: string;
  description: string;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  summary: string;
  description: string;
  tag: string;
  parameters: ApiParameter[];
  hasRequestBody: boolean;
  requestBodySchema?: RequestBodySchema;
  operationId?: string;
  deprecated?: boolean;
  responses?: ApiResponse[];
  requestBodyDescription?: string;
  externalDocs?: { url: string; description?: string };
}

export interface CategorySummary {
  tag: string;
  endpointCount: number;
}

export interface ApiEndpointSummary {
  method: string;
  path: string;
  summary: string;
  tag: string;
  parameters: ApiParameter[];
}

export interface ListApiResult {
  type: "categories" | "endpoints";
  categories?: CategorySummary[];
  endpoints?: ApiEndpointSummary[];
  totalCount: number;
  page: number;
  totalPages: number;
}

export type OAuthFlow = "authorization_code" | "client_credentials";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl?: string;
  tokenUrl: string;
  scopes: string[];
  flow: OAuthFlow;
  extraParams: Record<string, string>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  scope?: string;
}

export interface OAuthSecurityScheme {
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes: string[];
}
