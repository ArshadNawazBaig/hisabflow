import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_RESPONSE_HEADERS, WorkspaceAuthError, getWorkspaceUserWithCookies, type AuthCookieAdapter, type AuthCookieUpdate, type WorkspaceUser } from '@/lib/server/auth';

const authPages = new Set(['/login','/signup','/signin']);

/** Verify page access before rendering, while session cookies are writable. */
export async function proxy(request: NextRequest) {
  const pathname=request.nextUrl.pathname;
  if(pathname!=='/' && !authPages.has(pathname)) return NextResponse.next();

  const pending=new Map<string,AuthCookieUpdate>();
  const adapter:AuthCookieAdapter={
    getAll:()=>request.cookies.getAll(),
    setAll:updates=>{
      for(const update of updates){
        const expired=update.options.expires instanceof Date && update.options.expires.getTime()<=Date.now();
        if(update.value==='' || update.options.maxAge===0 || expired) request.cookies.delete(update.name);
        else request.cookies.set(update.name,update.value);
        pending.set(update.name,update);
      }
    },
  };

  let user:WorkspaceUser|null=null;
  let authError:'session_invalid'|'unavailable'|null=null;
  try{user=await getWorkspaceUserWithCookies(adapter);}
  catch(error){authError=error instanceof WorkspaceAuthError && error.status===401?'session_invalid':'unavailable';}

  let destination:URL|null=null;
  if(pathname==='/' && !user){
    destination=new URL('/login',request.url);
    if(authError) destination.searchParams.set('auth_error',authError);
  }else if(authPages.has(pathname) && user){
    destination=new URL('/',request.url);
  }else if(authPages.has(pathname) && authError && !request.nextUrl.searchParams.has('auth_error')){
    // One fixed error redirect provides a reset action without a redirect loop.
    destination=new URL(request.url);
    destination.searchParams.set('auth_error',authError);
  }

  const response=destination
    ?NextResponse.redirect(destination)
    :NextResponse.next({request:{headers:request.headers}});
  for(const update of pending.values()) response.cookies.set(update.name,update.value,update.options);
  for(const [name,value] of Object.entries(AUTH_RESPONSE_HEADERS)) response.headers.set(name,value);
  return response;
}

export const config={matcher:['/','/login','/signup','/signin']};
