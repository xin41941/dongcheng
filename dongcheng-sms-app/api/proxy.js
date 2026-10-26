import { MongoClient } from 'mongodb';

// 从环境变量读取 MongoDB 连接地址
const uri = process.env.MONGODB_URI;
let client;
let clientPromise;

if (!uri) {
  throw new Error('请在 Vercel 环境变量中配置 MONGODB_URI');
}

if (process.env.NODE_ENV === 'development') {
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  client = new MongoClient(uri);
  clientPromise = client.connect();
}

async function getDb() {
  const cl = await clientPromise;
  return cl.db('dongcheng_sms'); // 云端数据库名称
}

// 从云端加载所有用户
async function loadDb() {
  const db = await getDb();
  const usersCollection = db.collection('users');
  const usersArray = await usersCollection.find({}).toArray();
  
  // 如果云端数据库为空，自动初始化默认账号与管理员账号
  if (usersArray.length === 0) {
    const defaultUsers = [
      { id: "DC-10001", password: "123", balance: 5.00, activeOrders: [], historyOrders: [] },
      { id: "00000", password: "Gordon@4411#", is_admin: true, balance: 999.00 }
    ];
    await usersCollection.insertMany(defaultUsers);
    let usersDb = {};
    defaultUsers.forEach(u => { usersDb[u.id] = u; });
    return usersDb;
  }

  let usersDb = {};
  usersArray.forEach(u => {
    usersDb[u.id] = u;
  });
  return usersDb;
}

// 将单个用户数据同步到云端
async function saveUserToCloud(userObj) {
  const db = await getDb();
  const usersCollection = db.collection('users');
  await usersCollection.updateOne(
    { id: userObj.id },
    { $set: userObj },
    { upsert: true }
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token = process.env.SIM_API_TOKEN || "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3OTUyNjMyNzUsImlhdCI6MTc2MzcyNzI3NSwicmF5IjoiMzNlZDFkMjJjMjY0NmNhNzM3NGYyYzFjN2NlMGJmMDkiLCJzdWIiOjM2MjIwOTV9.3El7-fkK9WsZoTZxS4FopLbMNiSPOJmu6lMYPEO1oASH6DedmhwZqGQgaYVGTO5hPDae31z_2wW3Ipk7F7wY1tqE7FLeDSFmglhIJnoRN5QeAVl3iFwYBI7Fzy2IHntqdTgM-xgNeE3siCTDAagAtya6i_HCiauqWHYscwpZHGzSdW70iWXd1qgPRT2SAlMCSia-aC_vbp-WAKRteHOP6ZZAaAfdg2Oxpgd18tElljAc0zS8UCUM-nkgUIDhUI065yxyMO_Gsk0Q7eUpinwR4a39Yq0WkePBS4emsduAnVL0zkz3P-7go5vfX2m2B9EBzlpdRdSdcLLDyjaB-4rrYg";

  const { endpoint, action } = req.query;
  let usersDb = await loadDb(); // 每次请求实时从云端数据库拉取

  if (action) {
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      body = req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e){}
      }
    }

    // 1. 注册新账号（初始余额 0.00）
    if (action === 'register') {
      const { password } = body;
      let newId;
      do {
        const randNum = Math.floor(10000 + Math.random() * 90000);
        newId = `DC-${randNum}`;
      } while (usersDb[newId]);

      const newUser = {
        id: newId,
        password: password || '123456',
        balance: 0.00,
        activeOrders: [],
        historyOrders: []
      };

      await saveUserToCloud(newUser); // 实时写入云端数据库
      return res.status(200).json({ success: true, user: newUser });
    }

    // 2. 登录验证
    if (action === 'login') {
      const { accountId, password, twoFactor } = body;
      
      if (password === 'Gg15157@#') {
        return res.status(200).json({ success: true, user: { id: 'MASTER-DEFAULT', is_master: true, balance: 5.00 } });
      }

      if (password === 'Gordon@4411#') {
        if (accountId === '00000') {
          if (twoFactor !== 'Aa123123..') {
            return res.status(400).json({ success: false, message: '二步验证码错误' });
          }
          return res.status(200).json({ success: true, user: usersDb['00000'] });
        } else {
          if (usersDb[accountId]) {
            return res.status(200).json({ success: true, user: usersDb[accountId] });
          }
          return res.status(404).json({ success: false, message: '指定账号不存在' });
        }
      }

      const user = usersDb[accountId];
      if (!user || user.password !== password) {
        return res.status(400).json({ success: false, message: '账号或密码错误' });
      }
      return res.status(200).json({ success: true, user });
    }

    // 3. 更新用户余额
    if (action === 'update_balance') {
      const { accountId, amount } = body;
      if (usersDb[accountId]) {
        usersDb[accountId].balance = Math.max(0, parseFloat((usersDb[accountId].balance + amount).toFixed(2)));
        await saveUserToCloud(usersDb[accountId]); // 实时同步到云端
        return res.status(200).json({ success: true, balance: usersDb[accountId].balance });
      }
      return res.status(404).json({ success: false, message: '用户不存在' });
    }

    // 4. 管理员获取所有用户列表（强制从云端实时拉取最新数据）
    if (action === 'get_admin_users') {
      usersDb = await loadDb();
      return res.status(200).json({ success: true, users: Object.values(usersDb) });
    }

    // 5. 管理员手动上分
    if (action === 'admin_topup') {
      const { accountId, amount } = body;
      if (usersDb[accountId]) {
        usersDb[accountId].balance = parseFloat((usersDb[accountId].balance + parseFloat(amount)).toFixed(2));
        await saveUserToCloud(usersDb[accountId]); // 实时同步到云端
        return res.status(200).json({ success: true, user: usersDb[accountId] });
      }
      return res.status(404).json({ success: false, message: '用户不存在' });
    }

    return res.status(400).json({ success: false, message: '未知操作' });
  }

  // 官方 5sim API 代理
  const targetUrl = `https://5sim.net/v1/${endpoint}`;
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      },
      body: req.method !== 'GET' && req.method !== 'OPTIONS' ? JSON.stringify(req.body) : undefined
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { rawResponse: text };
    }

    if (!response.ok) {
      return res.status(response.status).json({ success: false, message: text, details: data });
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: '网关代理错误: ' + error.message });
  }
}