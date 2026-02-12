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
