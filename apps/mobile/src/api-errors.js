/** Plain messages for what goes wrong on the way to the server. */
export function friendlyNetworkError(error) {
  if (error?.status) return error;
  const slow = error?.name === 'AbortError';
  return Object.assign(new Error(slow
    ? 'The connection is slow. Please try again.'
    : 'Check your internet connection and try again.'), { offline: true });
}
export async function readResponse(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    if (response.ok) return null;
  }
  if (!response.ok) {
    const message = data?.error || (response.status >= 500 ? 'ELESEND is having a problem. Please try again shortly.' : 'That did not work. Please try again.');
    throw Object.assign(new Error(message), { status: response.status });
  }
  return data;
}
