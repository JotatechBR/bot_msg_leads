import { createApp } from '../server.js';

// Vercel invokes the API directly; npm start remains the local entry point.
const app = createApp({ deployment: 'vercel' });

export default function handler(request, response) {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const parameter = request.query?.route ?? url.searchParams.get('route');
  const route = Array.isArray(parameter) ? parameter.join('/') : parameter || url.pathname.replace(/^\/api\//, '');
  request.url = `/api/${route}`;
  return new Promise((resolve) => {
    const done = () => {
      response.off('finish', done);
      response.off('close', done);
      resolve();
    };
    response.once('finish', done);
    response.once('close', done);
    app.emit('request', request, response);
  });
}
