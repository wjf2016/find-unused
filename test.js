const Queue = require('queue');

const results = [];
const queue = Queue({
  concurrency: 5,
  results,
});

new Array(20).fill(null).forEach((item, index) => {
  queue.push(function () {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve(index);
      }, 500);
    });
  });
});

queue.start(function (err) {
  // 有错误发生时
  if (err) {
    console.log(err);
    return;
  }

  // 队列为空时
  console.log('all done:', results);
});
