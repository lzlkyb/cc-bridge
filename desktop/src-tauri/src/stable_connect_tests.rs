use super::*;

#[test]
fn real_python_writer_verifies_auth_and_preserves_unrelated_config() {
    // Runs only inside a temporary directory with a loopback fixture; never touches saved SSH servers.
    let harness = r#"import http.server, threading, tempfile, pathlib, sys, json, os, io, hashlib
source=sys.argv[1]
class Handler(http.server.BaseHTTPRequestHandler):
    redirect=False
    leaked=False
    def do_POST(self):
        if self.path!='/mcp': Handler.leaked=True
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path=='/mcp' and body['method']=='initialize'
        if self.redirect:
            self.send_response(307);self.send_header('Location','http://127.0.0.1:'+str(self.server.server_port)+'/stolen');self.end_headers();return
        ok=self.headers.get('Authorization')=='Bearer fixture-token'
        self.send_response(200 if ok else 401);self.end_headers()
        self.wfile.write(json.dumps({'result':{'serverInfo':{'name':'cc-bridge'}}}).encode())
    def log_message(self,*args): pass
    def do_GET(self): Handler.leaked=True;self.send_response(200);self.end_headers()
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
def apply(payload):
    sys.stdin=io.StringIO(json.dumps(payload)+'\n')
    try: exec(source,{})
    except SystemExit as e: return e.code
    return 0
with tempfile.TemporaryDirectory() as directory:
    os.environ['CLAUDE_CONFIG_DIR']=directory
    project=pathlib.Path(directory)/'project with spaces'
    project.mkdir();target=project/'.mcp.json'
    original={'mcpServers':{'other':{'command':'keep'}},'custom':{'nested':True}}
    target.write_text(json.dumps(original),encoding='utf-8')
    p={'port':server.server_port,'scope':'project','path':str(project),'token':'fixture-token','name':'cc-bridge-demo','transport':'http','deviceId':'demo','ports':[server.server_port],
       'access':{'target':None,'inspection':{'complete':True,'signature':'fixture','files':[
           {'scope':'project','projectPath':str(project),'configFile':str(target),'fingerprint':hashlib.sha256(target.read_bytes()).hexdigest()},
           {'scope':'user','projectPath':'','configFile':str(pathlib.Path(directory)/'.claude.json'),'fingerprint':'missing'}]}}}
    os.environ['http_proxy']='http://127.0.0.1:1';os.environ['no_proxy']=''
    assert apply(p)==0
    data=json.loads(target.read_text(encoding='utf-8'))
    assert data['custom']==original['custom'] and data['mcpServers']['other']==original['mcpServers']['other']
    assert data['mcpServers']['cc-bridge-demo']['headers']['Authorization']=='Bearer fixture-token'
    assert data['mcpServers']['cc-bridge-demo']['url']=='http://127.0.0.1:'+str(server.server_port)+'/mcp'
    before=target.read_bytes();p['token']='incorrect'
    assert apply(p)==43 and target.read_bytes()==before
    p['token']='fixture-token';Handler.redirect=True
    assert apply(p)==43 and target.read_bytes()==before and not Handler.leaked
    Handler.redirect=False
    p['token']='fixture-token';target.write_text('{invalid',encoding='utf-8')
    assert apply(p)==48 and target.read_text(encoding='utf-8')=='{invalid'
    assert not list(project.glob('.cc-bridge-*')) and not (project/'.mcp.json.cc-bridge-lock').exists()
    p['path']=str(project/'missing');assert apply(p)==44
    p['path']=str(project);target.write_text(json.dumps(original),encoding='utf-8')
    (project/'.mcp.json.cc-bridge-lock').mkdir();assert apply(p)==47
    assert json.loads(target.read_text())==original
server.shutdown()
print('FIXTURE_OK')
"#;
    let python = if cfg!(windows) { "python" } else { "python3" };
    let result = std::process::Command::new(python)
        .args(["-c", harness, REMOTE_CONFIGURE])
        .output()
        .expect("Python 3 is required to validate the remote configuration writer");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("FIXTURE_OK"));
}

#[test]
fn confirmed_endpoint_roundtrips_without_touching_ordinary_forwards() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .unwrap();
    let mut config = BridgeConfig::default();
    config.ssh_connections.push(crate::config::SshConnection {
        id: "cloud".into(),
        forwards: vec![ForwardRule {
            listen_port: 8888,
            target_port: 80,
            ..Default::default()
        }],
        ..Default::default()
    });
    config.stable_connect = StableSettings {
        method: Some("stable".into()),
        selected_connection_id: Some("cloud".into()),
        connections: vec![StableSaved {
            connection_id: "cloud".into(),
            port: 17823,
            scope: "user".into(),
            project_path: String::new(),
            multi_device: false,
            enabled: true,
            fingerprint: fingerprint(&config, "cloud"),
            token_fingerprint: crate::connection_access::token_fingerprint(&config),
            target: None,
            verified_at: None,
        }],
        direct: None,
    };
    crate::config::save_full_config(&db, &config).unwrap();
    let loaded = crate::config::load_config(&db).unwrap();
    assert_eq!(loaded.stable_connect.connections[0].port, 17823);
    assert_eq!(loaded.ssh_connections[0].forwards[0].listen_port, 8888);
    assert_eq!(method(&loaded), "stable");
    assert_eq!(
        candidate_ports(Some(loaded.stable_connect.connections[0].port), 9000),
        vec![17823]
    );
}
