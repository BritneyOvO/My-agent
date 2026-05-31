# CTF Platform Manager

一个 Python CTF 比赛平台管理框架：用 `ABC` 做类似 Java interface 的统一接口，各平台通过 adapter 重写同一组方法。当前已内置适配的平台：

- `ctfd`：标准 CTFd
- `gzctf`：GZCTF
- `nssctf`：NSSCTF 比赛 + 题库
- `adworld`：攻防世界 / XCTF AdWorld
- `ctfplus`：CTFPlus 主站 + play 节点

底层平台细节封装在 `ctf_platforms/vendor/`，上层统一通过 adapter 暴露一致接口。

## 统一接口

核心接口在 `ctf_platforms/base.py`。上层只传统一概念：contest、challenge、flag、分页和搜索；平台内部概念如 `race_id`、`practice_set_id`、`problem_bank`、`challenge_type`、`details` 不暴露给上层。

```python
class CTFPlatformClient(ABC):
    probe()
    login(credentials)
    load_session(path=None)
    save_session(path=None)
    current_user()
    list_contests(page=1, page_size=50, search=None)
    get_contest(contest_id)
    join_contest(contest_id, team_id=None, invite_code=None)
    list_challenges(contest_id=None, page=1, page_size=50, search=None)
    get_challenge(challenge_id, contest_id=None)
    download_attachment(challenge_id, outdir, contest_id=None)
    submit_flag(challenge_id, flag, contest_id=None)
    scoreboard(contest_id=None)
    raw_client()
```

不支持的能力也会在 adapter 里重写，并抛出 `UnsupportedOperation`，这样扩展点稳定。

## Python 用法

```python
from ctf_platforms import PlatformConfig, Credentials, create_client

client = create_client("ctfd", PlatformConfig(base_url="http://ctfd.example.com"))
client.login(Credentials("user", "pass"))
print(client.list_challenges())
print(client.get_challenge(1))
print(client.submit_flag(1, "flag{example}"))
```

## CLI 用法

```bash
python3 -m ctf_platforms.cli platforms
python3 -m ctf_platforms.cli -p ctfd --base-url http://ctfd.example.com probe
python3 -m ctf_platforms.cli -p ctfd --base-url http://ctfd.example.com login -u user -P pass
python3 -m ctf_platforms.cli -p ctfd --base-url http://ctfd.example.com login --token "$TOKEN"
python3 -m ctf_platforms.cli -p ctfd --base-url http://ctfd.example.com challenges
python3 -m ctf_platforms.cli -p ctfd --base-url http://ctfd.example.com challenge 1
python3 -m ctf_platforms.cli -p ctfd --base-url http://ctfd.example.com download 1 --outdir downloads/ctfd
python3 -m ctf_platforms.cli -p ctfd --base-url http://ctfd.example.com submit 1 'flag{example}'
```

认证统一为用户名密码或 token；业务操作不需要平台内部参数：

```bash
# GZCTF token auth: token can be global for all operations
python3 -m ctf_platforms.cli -p gzctf --base-url https://gz.example --token "$GZCTF_TOKEN" contests
# or saved through login
python3 -m ctf_platforms.cli -p gzctf --base-url https://gz.example login --token "$GZCTF_TOKEN"

# GZCTF 查看比赛详情/题目
python3 -m ctf_platforms.cli -p gzctf --base-url https://gz.example challenge 1001 --contest-id 1

# NSSCTF 题库：不传 --contest-id 即自动走题库
python3 -m ctf_platforms.cli -p nssctf challenges --page 1 --page-size 20
python3 -m ctf_platforms.cli -p nssctf download 6434 --outdir downloads/nss

# NSSCTF 比赛题：传 --contest-id 即自动走比赛接口
python3 -m ctf_platforms.cli -p nssctf challenge 1001 --contest-id 815

# AdWorld：传统一 contest_id，adapter 内部自动解析 race / practice set
python3 -m ctf_platforms.cli -p adworld challenges --contest-id CONTEST_ID
python3 -m ctf_platforms.cli -p adworld challenge CHALLENGE_ID --contest-id CONTEST_ID

# CTFPlus play 节点 cookie
python3 -m ctf_platforms.cli -p ctfplus --token 'session=...' challenges --contest-id FlyCTF
```

## 测试

本地回归测试不依赖真实平台账号，会用 fake vendor client 覆盖统一登录和操作链：

```bash
python3 -m unittest -v
```

覆盖范围：用户名密码登录、token 登录、session 保存/加载、比赛列表/详情、加入比赛、题目列表/详情、附件下载、flag 提交、榜单能力。

## 作为后端服务部署

项目内置了一个薄 FastAPI 服务层：HTTP 只处理会话、参数校验和统一路由；平台细节仍由 adapter/vendor 负责。

### 本地启动

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e .

# 默认监听 127.0.0.1:8000，运行数据写到 .runtime/
ctf-platform-api
```

或：

```bash
CTF_PLATFORM_HOST=0.0.0.0 CTF_PLATFORM_PORT=8000 CTF_PLATFORM_DATA_DIR=/var/lib/ctf-platform \
  uvicorn ctf_platforms.server:app --host 0.0.0.0 --port 8000
```

### API 示例

```bash
# 创建登录会话，返回 session_id
curl -s http://127.0.0.1:8000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "platform":"ctfd",
    "base_url":"https://kalmarc.tf/",
    "auth":{"username":"USER","password":"PASS"}
  }'

# 后续都只使用 session_id
SID=<上一步返回的 session_id>
curl -s "http://127.0.0.1:8000/api/sessions/$SID/me"
curl -s "http://127.0.0.1:8000/api/sessions/$SID/challenges?page=1&page_size=20"
curl -s "http://127.0.0.1:8000/api/sessions/$SID/challenges/13"
curl -s -X POST "http://127.0.0.1:8000/api/sessions/$SID/challenges/13/submit" \
  -H 'Content-Type: application/json' \
  -d '{"flag":"flag{example}"}'
```

有比赛概念的平台统一使用 `contest_id` 查询参数：

```bash
curl -s "http://127.0.0.1:8000/api/sessions/$SID/contests?page=1&page_size=20"
curl -s "http://127.0.0.1:8000/api/sessions/$SID/challenges?contest_id=CONTEST_ID"
curl -s -X POST "http://127.0.0.1:8000/api/sessions/$SID/challenges/CHALLENGE_ID/submit?contest_id=CONTEST_ID" \
  -H 'Content-Type: application/json' \
  -d '{"flag":"flag{example}"}'
```

### 生产部署建议

- 用 Nginx/Caddy 做 HTTPS 和反向代理，后端只监听 `127.0.0.1` 或内网。
- 设置 `CTF_PLATFORM_DATA_DIR=/var/lib/ctf-platform`，并限制目录权限；这里会保存平台 session。
- 在外层加自己的用户鉴权/API Key，不要把该服务裸露到公网。
- 多用户场景下，把 `session_id` 绑定到你的业务用户；不要让用户访问别人的 session。
- 下载目录建议定期清理，或改成对象存储。

systemd 示例：

```ini
[Unit]
Description=CTF Platform Manager API
After=network.target

[Service]
WorkingDirectory=/opt/ctf-platform-manager
Environment=CTF_PLATFORM_HOST=127.0.0.1
Environment=CTF_PLATFORM_PORT=8000
Environment=CTF_PLATFORM_DATA_DIR=/var/lib/ctf-platform
ExecStart=/opt/ctf-platform-manager/.venv/bin/uvicorn ctf_platforms.server:app --host 127.0.0.1 --port 8000 --workers 2
Restart=always
User=ctfplatform
Group=ctfplatform

[Install]
WantedBy=multi-user.target
```

## 新平台扩展

参考 `examples/custom_platform.py`：继承 `CTFPlatformClient`，实现全部方法，加 `@register_platform("alias")` 即可。
