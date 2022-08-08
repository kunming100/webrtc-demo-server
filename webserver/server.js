"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const serveIndex = require("serve-index");
const express = require("express");
const { Server: ioServer } = require("socket.io");

// 房间内用户最大个数限制
const MAX_USER_LIMIT = 3;

// socket 命令
const SOCKET_COMMAND = {
  // peer connection 已创建
  CREATED_PC: "createPC",
  // 交换SDP的命令
  SDP: "sdp",
  // ICE candidate
  ICE: "ice",
  // 消息通知
  MESSAGE: "message",
  // 创建房间
  CREATE: "create",
  // 加入房间
  JOIN: "join",
  // 已加入房间
  JOINED: "joined",
  // 其他人加入房间
  OTHER_JOINED: "otherJoined",
  // 离开房间
  LEAVE: "leave",
  // 已离开房间
  LEFT: "left",
  // 其他人已离开房间
  OTHER_LEFT: "otherLeft",
  // 更换房主
  CHANGE_ROOMOWNER: "changeRoomowner",
  // 已中断连接
  DISCONNECTED: "disconnected",
  // 房间已满
  FULL: "full",
};

// const staticPath = "/Users/tankm/Documents/projects/tuzhanai/webrtc-demo/dist";
const staticPath = "./webserver";

const app = express();
//顺序不能换
app.use(serveIndex(staticPath));
app.use(express.static(staticPath));

//加载本地路径下的ssl证书，专用于https， 没相关的域名以及证书，https将无法访问，有证书在webserver路径下新建cert目录，将证书拷入
const options = {
  key: fs.readFileSync("/etc/nginx/ssl/tanscode.cn.key"),
  cert: fs.readFileSync("/etc/nginx/ssl/tanscode.cn.pem"),
};

//httpsServer 有证书就直接拷贝到cert路径下，在填入options中，没有就填null，https服务将无法访问
var httpsServer = https.createServer(options, app);
// //httpServer
// var httpServer = http.createServer(app);

// bind socket.io with httpsServer
var sockio = new ioServer(httpsServer, {
  cors: {
    // 本地调试
    // origin: "http://localhost:3000",
    origin: "https://tankscode.cn",
  },
});

// 房主 map 房间号-房主userId
let roomowerMap = new Map();
// socket 连接 map userId-socket
const socketConnectMap = new Map();

// 找到指定房间
function getRoom(roomId) {
  return sockio.sockets.adapter.rooms.get(roomId);
}

/**
 * 获取房间内的socket连接
 * @param {string} roomId 房间id
 * @param {string[]} excludes 需要排除的socketId
 * @returns
 */
async function getSocketsInRoom(roomId, excludes = []) {
  const room = getRoom(roomId);
  if (!room) {
    console.log("找不到房间");
    return [];
  }
  const socketSet = await sockio.sockets.adapter.sockets(room);
  const allSockets = await sockio.fetchSockets();
  const sockets = [];
  socketSet.forEach((socketId) => {
    if (!excludes.includes(socketId)) {
      const socket = allSockets.find((socket) => socket.id === socketId);
      socket && sockets.push(socket);
    }
  });
  return sockets;
}

/**
 * 判断是否是房主
 * @param {string} roomId
 * @param {string} userId
 */
function isRoomowner(roomId, userId) {
  if (!roomowerMap.has(roomId)) {
    return false;
  }
  const roomowner = roomowerMap.get(roomId);
  return roomowner === userId;
}

/**
 * 获取下一任房主
 * @param {string} roomId 房间id
 */
function getNewRoomowner(roomId) {
  const originalRoomowner = roomowerMap.get(roomId);
  const room = getRoom(roomId);
  if (!room) return;
  const socketConnections = socketConnectMap.entries();
  let newRoomowner = {};
  let temp = socketConnections.next();
  while (!Object.keys(newRoomowner).length && !temp.done) {
    const [userId, socket] = temp.value;
    temp = socketConnections.next();
    if (originalRoomowner !== userId && room.has(socket.id))
      newRoomowner = { userId, socketId: socket.id };
  }
  return newRoomowner;
}

// 监听
sockio.on("connection", (socket) => {
  const {
    handshake: {
      auth: { userId },
    },
  } = socket;
  console.log(`用户 ${userId} 连接成功!!! socketId是 ${socket.id}`);
  socketConnectMap.set(userId, socket);

  // 监听SDP交换
  socket.on(
    SOCKET_COMMAND.SDP,
    ({ roomId, socketId, senderUserId, recipientUserId, desc } = {}) => {
      const socket = socketConnectMap.get(recipientUserId);
      socket.emit(SOCKET_COMMAND.SDP, { userId: senderUserId, desc });
    }
  );

  // ICE
  socket.on(
    SOCKET_COMMAND.ICE,
    ({ senderUserId, recipientUserId, candidate }) => {
      const socket = socketConnectMap.get(recipientUserId);
      socket.emit(SOCKET_COMMAND.ICE, { userId: senderUserId, candidate });
    }
  );

  // 监听消息通知
  socket.on(SOCKET_COMMAND.MESSAGE, async (roomId, msg) => {
    // 通知房间内其他人：xxx加入到房间
    const otherSockets = await getSocketsInRoom(roomId, [socket.id]);
    otherSockets.forEach((socket) => {
      socket.emit(SOCKET_COMMAND.MESSAGE, msg);
    });
  });

  // 监听用户创建房间
  socket.on(SOCKET_COMMAND.CREATE, ({ userId }) => {
    const newRoomId = socket.id;
    // 将房主的userId添加到映射中
    roomowerMap.set(newRoomId, userId);
  });

  // 监听用户加入
  socket.on(SOCKET_COMMAND.JOIN, async ({ roomId, userId }) => {
    const room = getRoom(roomId);
    if (!room) {
      socket.emit(SOCKET_COMMAND.MESSAGE, "此房间不存在，加入房间失败");
      return;
    }
    const roomownerId = roomowerMap.get(roomId);
    if (!roomownerId) {
      socket.emit(SOCKET_COMMAND.MESSAGE, "此房间不存在房主，加入房间失败");
      return;
    }

    if (room.size < MAX_USER_LIMIT) {
      // 加入房间
      socket.join(roomId);
      // 通知加入者已经成功加入了房间
      socket.emit(SOCKET_COMMAND.JOINED, {
        roomId,
        roomownerId,
        roomSize: room.size,
      });
      if (room.size > 1) {
        // 通知房间内其他人：xxx加入到房间
        const otherSockets = await getSocketsInRoom(roomId, [socket.id]);
        otherSockets.forEach((socket) => {
          socket.emit(SOCKET_COMMAND.OTHER_JOINED, {
            socketId: socket.id,
            joinedId: userId,
          });
          socket.emit(SOCKET_COMMAND.MESSAGE, `${userId}已加入房间`);
        });
      }
    } else {
      // 通知当前加入者，房间已满
      socket.emit(SOCKET_COMMAND.FULL);
    }
  });

  // 监听用户离开
  socket.on(SOCKET_COMMAND.LEAVE, async ({ roomId, senderUserId }) => {
    let newRoomowner = {};
    let shouldSetNewRoomowner = false;
    // 房间内其他人
    const otherSockets = await getSocketsInRoom(roomId, [socket.id]);
    // 如果是房主离开房间，那么需要选择房间内另一个人成为房主
    if (isRoomowner(roomId, senderUserId)) {
      newRoomowner = getNewRoomowner(roomId);
      shouldSetNewRoomowner = Object.keys(newRoomowner).length > 0;
      if (shouldSetNewRoomowner) {
        roomowerMap.set(newRoomowner.socketId, newRoomowner.userId);
        roomowerMap.delete(roomId);
      }
    }
    // 通知房间内的人，某人将退出房间，关闭peer connection通道
    otherSockets.forEach((socket) => {
      if (shouldSetNewRoomowner) {
        // 通知房间内其他人，修改url中的room参数为新房主的socketId
        socket.emit(SOCKET_COMMAND.CHANGE_ROOMOWNER, {
          roomId,
          newOwnerUserId: newRoomowner.userId,
          newOwnerSocketId: newRoomowner.socketId,
        });
      }
      socket.emit(SOCKET_COMMAND.OTHER_LEFT, {
        roomId,
        senderUserId,
      });
      socket.emit(SOCKET_COMMAND.MESSAGE, `${senderUserId}已退出房间`);
    });
    // 通知离开的人，已成功退出房间
    socket.emit(SOCKET_COMMAND.LEFT, { roomId });
    // 离开房间
    socket.leave(roomId);
  });
});

httpsServer.listen(3010, "0.0.0.0", function () {
  console.log("HTTP Server is running");
});

// 用户
const userInfo = [
  {
    id: "382437913343",
    name: "张三",
  },
  {
    id: "894891429342",
    name: "李四",
  },
  {
    id: "972468303473",
    name: "王五",
  },
];

app.get("/api/getUserInfo", (req, res) => {
  const { userId } = req.query;
  const target = userInfo.find((n) => n.id === userId);
  res.send(target);
});
