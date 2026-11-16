import { createClient } from "npm:@supabase/supabase-js@2.108.2";
import { buildLeagueCompRun } from "../../../src/leagueCompRun.ts";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});

// Public approved-result projection. No originals, exact coordinates, UTC times,
// account information or weather locations are returned to the visitor.
Deno.serve(async request=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(request.method!=="POST")return reply(405,{error:"POST required"});
  try {
    const body=await request.text();
    if(body.length>2000)return reply(400,{error:"Invalid request"});
    const {entry_id}=JSON.parse(body);
    if(typeof entry_id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry_id))return reply(400,{error:"Invalid entry"});
    const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
    const {data:entry,error}=await admin.from("league_entries").select("id,user_id,round_id,file_path,ground_elevation_m,wind_snapshot,revision,comp_run_data").eq("id",entry_id).eq("status","approved").maybeSingle();
    if(error)throw error;
    if(!entry)return reply(404,{error:"This approved comp run is unavailable."});
    const published=async()=>{
      const {data,error}=await admin.from("league_rounds").select("id").eq("id",entry.round_id).eq("published",true).maybeSingle();
      if(error)throw error;
      return !!data;
    };
    if(!await published())return reply(404,{error:"This round is not published."});
    if(entry.comp_run_data)return reply(200,entry.comp_run_data);
    const prefix=`${entry.user_id}/${entry.round_id}/`;
    if(!entry.file_path.startsWith(prefix) || !/^[0-9a-f-]{36}[.]csv$/.test(entry.file_path.slice(prefix.length)))throw new Error("Invalid original file path.");
    const file=await admin.storage.from("league-tracks").download(entry.file_path);
    if(file.error || !file.data)throw new Error("The original track is unavailable.");
    if(file.data.size>8388608)throw new Error("Track exceeds 8 MB.");
    const data=buildLeagueCompRun(await file.data.text(),entry.ground_elevation_m,entry.wind_snapshot);
    const saved=await admin.from("league_entries").update({comp_run_data:data}).eq("id",entry.id).eq("revision",entry.revision).eq("status","approved").eq("file_path",entry.file_path).select("id");
    if(saved.error)throw saved.error;
    if(!saved.data?.length || !await published())return reply(404,{error:"This result changed or is no longer public. Refresh the scoreboard."});
    return reply(200,data);
  }catch(error){return reply(400,{error:error instanceof Error?error.message:(error as {message?:string}).message??"Comp run could not load."});}
});
