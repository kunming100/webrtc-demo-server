FROM node
LABEL name="webrtc-demo-server"
LABEL version="1.0"
COPY . /app
WORKDIR /app
RUN npm install
EXPOSE 3010
CMD npm run serve
