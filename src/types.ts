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

export interface ApiEndpoint {
  method: string;
  path: string;
  summary: string;
  description: string;
  tag: string;
  parameters: ApiParameter[];
  hasRequestBody: boolean;
  requestBodySchema?: RequestBodySchema;
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
