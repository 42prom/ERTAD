function record(value:unknown):value is Record<string,unknown> {
  return value!==null && typeof value==='object';
}
/** Read only a bounded error message, never stringify transport objects or bodies. */
export function apiErrorMessage(error: unknown, fallback = 'Request failed'): string {
  if(record(error) && record(error.response) && record(error.response.data)){
    const detail=error.response.data.error;
    if(typeof detail==='string')return detail.slice(0,300);
    if(record(detail)&&typeof detail.message==='string')return detail.message.slice(0,300);
  }
  return error instanceof Error ? error.message.slice(0,300) : fallback;
}
export function apiErrorStatus(error:unknown):number|undefined {
  if(record(error)&&record(error.response)&&typeof error.response.status==='number'&&Number.isInteger(error.response.status)
    &&error.response.status>=100&&error.response.status<=599)return error.response.status;
  return undefined;
}
