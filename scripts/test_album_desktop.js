const assert = require('node:assert/strict');
const { validateGroups, validatePreferences } = require('../lib/album_desktop');
const ids = new Set([1, 2, 3]);
const groups = validateGroups([{ id: 'campus', name: '校园风光', projectIds: [1, 1, 2] }], ids);
assert.deepEqual(groups[0].projectIds, [1, 2]);
assert.throws(() => validateGroups([{ id: 'campus', name: '越权', projectIds: [99] }], ids), error => error.status === 403);
assert.throws(() => validateGroups([{id:'x',name:'一'},{id:'x',name:'二'}], ids));
assert.throws(() => validateGroups([{id:'x',name:' '}], ids));
assert.throws(() => validateGroups([{id:'x',name:'年份',kind:'smart',rule:{year:'bad'}}], ids));
const preferences = validatePreferences({ pins: ['album:1','album:99','group:campus','group:hidden'],
  recentItems: [{id:1,visitedAt:1},{id:1},{id:99}], colors:{campus:'#fafafa',hidden:'#ffffff'}, dismissed:[1,99] },groups,ids);
assert.deepEqual(preferences.pins,['album:1','group:campus']);
assert.deepEqual(preferences.recentItems,[{id:1,visitedAt:1}]);
assert.deepEqual(preferences.colors,{campus:'#fafafa'});
assert.deepEqual(preferences.dismissed,[1]);

// Route integration with isolated SQL doubles: no production database is used.
const shared = { state: { groups }, revision: 2 };
const personal = { state: preferences, revision: 4 };
const calls = [];
let committed = false, rolledBack = false;
const db = { async query(sql, params) {
  calls.push({sql,params});
  if(sql.startsWith('INSERT'))return [{}];
  if(sql.startsWith('SELECT p.id')) {
    assert(sql.includes('p.organization_id = ? AND p.unit_id = ?'));
    assert.deepEqual(params,[7,9]);
    return [[{id:1},{id:2},{id:3}]];
  }
  if(sql.includes('SELECT state, revision FROM album_desktop_workspaces'))return [[shared]];
  if(sql.includes('SELECT state, revision FROM album_desktop_users'))return [[personal]];
  if(sql.startsWith('UPDATE album_desktop_workspaces')){assert.deepEqual(params.slice(1),[7,9]);return [{}];}
  if(sql.startsWith('UPDATE album_desktop_users')){assert.deepEqual(params.slice(1),[12,7,9]);return [{}];}
  throw new Error('Unexpected SQL '+sql);
}, async beginTransaction(){},async commit(){committed=true},async rollback(){rolledBack=true},release(){} };
const stub=(name,exports)=>{require.cache[require.resolve(name)]={id:require.resolve(name),filename:require.resolve(name),loaded:true,exports};};
stub('../db',{pool:{...db,async getConnection(){return db}}});
stub('../lib/permissions',{requirePermission:()=> (req,res,next)=>{req.user={id:12,organization_id:7,role:'admin'};next()}});
stub('../lib/media_access',{buildMediaUrl:value=>value});
stub('../lib/workspace_access',{
  resolveWorkspace:async req=>({enabled:true,userId:12,orgId:7,unitId:9,collegeAdmin:false,role:req.get('x-test-role') || 'editor'}),
  projectListScope:()=>({sql:'p.unit_id = ?',params:[9]}),unitRoleAllows:role=>role==='editor',sendWorkspaceError:()=>false,
});
const express=require('express');const app=express();app.use(express.json());app.use('/desktop',require('../routes/album_desktop'));
const server=app.listen(0,'127.0.0.1',async()=>{
 try{
  const endpoint=`http://127.0.0.1:${server.address().port}/desktop/state`;
  const put=(body,headers={})=>fetch(endpoint,{method:'PUT',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const ok=await put({groups,preferences,workspaceRevision:2,userRevision:4});
  assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{workspaceRevision:3,userRevision:5});assert(committed);
  const count=calls.filter(c=>c.sql.startsWith('UPDATE')).length;
  assert.equal((await put({groups,workspaceRevision:1})).status,409);assert(rolledBack);
  assert.equal(calls.filter(c=>c.sql.startsWith('UPDATE')).length,count);
  assert.equal((await put({groups,workspaceRevision:2},{'x-test-role':'member'})).status,403);
  assert.equal((await put({preferences,userRevision:4},{'x-test-role':'member'})).status,200);
  assert.equal((await put({groups:[{id:'foreign',name:'越权',projectIds:[99]}],workspaceRevision:2})).status,403);
  assert.equal((await put({preferences,userRevision:4,scope:{userId:99,organizationId:7,unitId:9}})).status,409);
  console.log('PASS: desktop validation, scope isolation, personal preferences, revisions, permissions and rollback');
 }catch(error){console.error(error);process.exitCode=1}finally{server.close();}
});
