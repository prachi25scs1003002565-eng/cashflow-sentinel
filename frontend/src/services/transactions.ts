import { frontendEnv } from '../config/env';
import { getAccessToken } from './auth';

export interface TransactionItem {
  id: string;
  business_id: string;
  account_id: string;
  category_id: string | null;
  category_name?: string | null;
  account_name?: string | null;
  transaction_date: string;
  transaction_type: string;
  cash_direction: 'INFLOW' | 'OUTFLOW';
  amount_paise: string;
  amount_rupees?: number;
  description: string | null;
  counterparty_name: string | null;
  record_status: string;
  created_at: string;
}

export interface TransactionSummary {
  total_income_paise: string;
  total_expense_paise: string;
  net_cash_flow_paise: string;
  current_cash_balance_paise: string;
  total_income_rupees: number;
  total_expense_rupees: number;
  net_cash_flow_rupees: number;
  current_cash_balance_rupees: number;
  transaction_count: number;
  currency_code: string;
  recent_transactions: TransactionItem[];
}

export interface TransactionCategory {
  id: string;
  category_code: string;
  display_name: string;
  allowed_direction: 'INFLOW' | 'OUTFLOW' | 'BOTH';
  is_active?: boolean;
}

export interface CreateTransactionPayload {
  type: 'income' | 'expense';
  amount: number | string;
  category?: string;
  category_id?: string;
  description?: string;
  transaction_date: string;
}

export interface UpdateTransactionPayload {
  amount?: number | string;
  category?: string;
  category_id?: string | null;
  description?: string | null;
  counterparty_name?: string | null;
  transaction_date?: string;
}

interface ApiResponse<T> {
  data: T;
  meta?: {
    request_id?: string;
    pagination?: {
      page?: number;
      limit?: number;
      page_size?: number;
      total_items?: number;
      total_count?: number;
      total_pages?: number;
      next_cursor: string | null;
    };
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

async function authFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await authFetchWithMeta<T>(endpoint, options);
  return res.data;
}

async function authFetchWithMeta<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T; meta?: ApiResponse<T>['meta'] }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('You must be signed in to access transaction data.');
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...((options.headers as Record<string, string>) || {}),
  };

  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${frontendEnv.API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const payload: ApiResponse<T> = await response.json();

  if (!response.ok || payload.error) {
    const errorMsg = payload.error?.message || `Request failed with status ${response.status}`;
    throw new Error(errorMsg);
  }

  return { data: payload.data, meta: payload.meta };
}

export async function fetchTransactionSummary(): Promise<TransactionSummary> {
  return authFetch<TransactionSummary>('/transactions/summary');
}

export interface TransactionFilters {
  page?: number;
  limit?: number;
  from_date?: string;
  to_date?: string;
  type?: 'income' | 'expense' | 'all';
  cash_direction?: 'INFLOW' | 'OUTFLOW';
  category_id?: string;
  search?: string;
  page_size?: number;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  page_size: number;
  total_items: number;
  total_count: number;
  total_pages: number;
}

export interface PaginatedTransactionsResponse {
  items: TransactionItem[];
  pagination: PaginationInfo;
}

export async function fetchPaginatedTransactions(
  filters?: TransactionFilters
): Promise<PaginatedTransactionsResponse> {
  const params = new URLSearchParams();
  if (filters?.page) params.append('page', String(filters.page));
  if (filters?.limit) params.append('limit', String(filters.limit));
  if (filters?.from_date) params.append('from_date', filters.from_date);
  if (filters?.to_date) params.append('to_date', filters.to_date);
  if (filters?.type && filters.type !== 'all') params.append('type', filters.type);
  if (filters?.cash_direction) params.append('cash_direction', filters.cash_direction);
  if (filters?.category_id) params.append('category_id', filters.category_id);
  if (filters?.search && filters.search.trim()) params.append('search', filters.search.trim());
  if (filters?.page_size) params.append('page_size', String(filters.page_size));

  const query = params.toString() ? `?${params.toString()}` : '';
  const { data, meta } = await authFetchWithMeta<TransactionItem[]>(`/transactions${query}`);

  const page = meta?.pagination?.page || filters?.page || 1;
  const limit = meta?.pagination?.limit || meta?.pagination?.page_size || filters?.limit || 10;
  const totalItems = meta?.pagination?.total_items ?? meta?.pagination?.total_count ?? data.length;
  const totalPages = meta?.pagination?.total_pages ?? (totalItems === 0 ? 0 : Math.ceil(totalItems / limit));

  return {
    items: data,
    pagination: {
      page,
      limit,
      page_size: limit,
      total_items: totalItems,
      total_count: totalItems,
      total_pages: totalPages,
    },
  };
}

export async function fetchTransactions(filters?: TransactionFilters): Promise<TransactionItem[]> {
  const res = await fetchPaginatedTransactions(filters);
  return res.items;
}

export async function fetchCategories(): Promise<TransactionCategory[]> {
  return authFetch<TransactionCategory[]>('/transactions/categories');
}

export async function createTransaction(input: CreateTransactionPayload): Promise<TransactionItem> {
  return authFetch<TransactionItem>('/transactions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateTransaction(
  transactionId: string,
  input: UpdateTransactionPayload
): Promise<TransactionItem> {
  return authFetch<TransactionItem>(`/transactions/${transactionId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteTransaction(
  transactionId: string
): Promise<{ id: string; record_status: string; message: string }> {
  return authFetch<{ id: string; record_status: string; message: string }>(
    `/transactions/${transactionId}`,
    {
      method: 'DELETE',
    }
  );
}
