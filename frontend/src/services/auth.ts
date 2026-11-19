
import { frontendEnv } from '../config/env';

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  account_status: string;
}

interface AuthResponse {
  data: {
    user: AuthUser;
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
  };
}

const TOKEN_KEY = 'cashflow_sentinel_token';

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    `${frontendEnv.API_BASE_URL}${endpoint}`,
    {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    },
  );

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
      payload?.message ||
      `Request failed (${response.status})`,
    );
  }

  return payload as T;
}

export async function login(email: string, password: string) {
  const result = await request<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  sessionStorage.setItem(TOKEN_KEY, result.data.access_token);
  return result.data.user;
}

export async function register(
  display_name: string,
  email: string,
  password: string,
) {
  const result = await request<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ display_name, email, password }),
  });

  sessionStorage.setItem(TOKEN_KEY, result.data.access_token);
  return result.data.user;
}

export async function getCurrentUser(): Promise<AuthUser> {
  const token = sessionStorage.getItem(TOKEN_KEY);

  if (!token) {
    throw new Error('Not authenticated');
  }

  const result = await request<{ data: AuthUser }>('/auth/me', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return result.data;
}

export async function logout() {
  const token = sessionStorage.getItem(TOKEN_KEY);

  try {
    if (token) {
      await request<void>('/auth/logout', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    }
  } finally {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

export function getAccessToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}
