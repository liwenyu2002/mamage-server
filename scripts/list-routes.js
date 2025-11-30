const photos = require('../routes/photos');
function list(router) {
  const out = [];
  if (!router || !router.stack) return out;
  for (const layer of router.stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      out.push(`${methods} ${layer.route.path}`);
    } else if (layer.name === 'router') {
      out.push(`<router> ${layer.regexp}`);
    } else {
      out.push(`<middleware> ${layer.name}`);
    }
  }
  return out;
}
console.log(list(photos).join('\n'));
console.log('\nupload module keys:');
const uploadMod = require('../routes/upload');
console.log(Object.keys(uploadMod));
