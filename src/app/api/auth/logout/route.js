import { clearAuthCookie } from '@/lib/auth';
import { jsonOk, noStoreHeaders } from '@/lib/apiResponse';

export async function POST() {
  const response = jsonOk({ message: 'Dang xuat thanh cong' }, { headers: noStoreHeaders() });
  clearAuthCookie(response);
  return response;
}
